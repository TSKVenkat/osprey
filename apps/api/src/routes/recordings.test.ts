import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mediaAssets } from '@bilby/db';

import {
  TEST_ADMIN,
  type Harness,
  configureLocalStorage,
  createHarness,
  createUserAndLogin,
  login,
} from '../testing/harness.ts';

describe('recordings', () => {
  let harness: Harness;
  let cookie: string;

  beforeEach(async () => {
    harness = await createHarness();
    cookie = await login(harness.app, TEST_ADMIN);
    await configureLocalStorage(harness, cookie);
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Records something end to end and returns its id. */
  async function record(title: string, as = cookie): Promise<string> {
    const started = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: { cookie: as },
      payload: { title, mimeType: 'video/webm' },
    });
    const { recordingId, uploadSessionId } = started.json();

    await harness.app.inject({
      method: 'PUT',
      url: `/v1/uploads/${uploadSessionId}/parts/1`,
      headers: { cookie: as, 'content-type': 'application/octet-stream' },
      payload: randomBytes(2048),
    });
    await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadSessionId}/complete`,
      headers: { cookie: as },
    });

    return recordingId;
  }

  function list(query = '', as = cookie) {
    return harness.app.inject({ method: 'GET', url: `/v1/recordings${query}`, headers: { cookie: as } });
  }

  it('lists the caller\'s recordings, newest first', async () => {
    await record('First');
    await record('Second');
    await record('Third');

    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json().recordings.map((r: { title: string }) => r.title)).toEqual([
      'Third',
      'Second',
      'First',
    ]);
  });

  it('pages with a cursor rather than an offset', async () => {
    for (const title of ['A', 'B', 'C', 'D', 'E']) await record(title);

    const first = await list('?limit=2');
    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`);
    const third = await list(`?limit=2&cursor=${encodeURIComponent(second.json().nextCursor)}`);

    expect(first.json().recordings.map((r: { title: string }) => r.title)).toEqual(['E', 'D']);
    expect(second.json().recordings.map((r: { title: string }) => r.title)).toEqual(['C', 'B']);
    expect(third.json().recordings.map((r: { title: string }) => r.title)).toEqual(['A']);
    // No more rows, so no cursor to follow.
    expect(third.json().nextCursor).toBeNull();
  });

  it('shows each person only their own recordings', async () => {
    const member = await createUserAndLogin(harness.app, cookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });
    await record('Mine');
    await record('Theirs', member.cookie);

    const mine = await list();
    const theirs = await list('', member.cookie);

    expect(mine.json().recordings.map((r: { title: string }) => r.title)).toEqual(['Mine']);
    expect(theirs.json().recordings.map((r: { title: string }) => r.title)).toEqual(['Theirs']);
  });

  it('lets an admin ask for everything, and ignores the same request from a user', async () => {
    const member = await createUserAndLogin(harness.app, cookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });
    await record('Admin recording');
    await record('Member recording', member.cookie);

    const asAdmin = await list('?all=1');
    const asMember = await list('?all=1', member.cookie);

    expect(asAdmin.json().recordings).toHaveLength(2);
    // The flag is not a way for a user to promote themselves.
    expect(asMember.json().recordings).toHaveLength(1);
  });

  it('returns a recording with a playable URL', async () => {
    const id = await record('Playable');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/${id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().recording).toMatchObject({ title: 'Playable', state: 'ready' });
    // Playable from the original, before any processing has run. This is what keeps
    // the link useful the moment the upload finishes.
    expect(response.json().playback.url).toMatch(/^https?:\/\//);
    expect(response.json().assets.map((a: { kind: string }) => a.kind)).toEqual(['original']);
  });

  it('hides one person\'s recording from another', async () => {
    const id = await record('Private');
    const member = await createUserAndLogin(harness.app, cookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/${id}`,
      headers: { cookie: member.cookie },
    });

    // 404 rather than 403: a 403 would confirm the id is real.
    expect(response.statusCode).toBe(404);
  });

  it('lets an admin open anyone\'s recording', async () => {
    const member = await createUserAndLogin(harness.app, cookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });
    const id = await record('Theirs', member.cookie);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/${id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('renames a recording', async () => {
    const id = await record('Before');

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/recordings/${id}`,
      headers: { cookie },
      payload: { title: 'After' },
    });

    expect(response.json().recording.title).toBe('After');
  });

  it('refuses a rename from someone else', async () => {
    const id = await record('Mine');
    const member = await createUserAndLogin(harness.app, cookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/recordings/${id}`,
      headers: { cookie: member.cookie },
      payload: { title: 'Hijacked' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('removes a deleted recording from the list and from view', async () => {
    const id = await record('Doomed');

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/recordings/${id}`,
      headers: { cookie },
    });

    expect(deleted.statusCode).toBe(204);
    expect((await list()).json().recordings).toEqual([]);
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/${id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(404);
  });

  it('keeps the row after a delete, so the files can still be cleaned up later', async () => {
    const id = await record('Doomed');
    await harness.app.inject({ method: 'DELETE', url: `/v1/recordings/${id}`, headers: { cookie } });

    const row = await harness.db.query.recordings.findFirst();

    // Soft delete: the sweeper needs the row to know which objects to remove, and it
    // leaves a window in which an accidental delete can be undone.
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('refuses anonymous callers', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/recordings' });
    expect(response.statusCode).toBe(401);
  });
});

describe('thumbnails', () => {
  let harness: Harness;
  let cookie: string;

  beforeEach(async () => {
    harness = await createHarness();
    cookie = await login(harness.app, TEST_ADMIN);
    await configureLocalStorage(harness, cookie);
  });

  afterEach(async () => {
    await harness.close();
  });

  async function record(title: string): Promise<string> {
    const started = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: { cookie },
      payload: { title, mimeType: 'video/webm' },
    });
    const { recordingId, uploadSessionId } = started.json();
    await harness.app.inject({
      method: 'PUT',
      url: `/v1/uploads/${uploadSessionId}/parts/1`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: randomBytes(2048),
    });
    await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadSessionId}/complete`,
      headers: { cookie },
    });
    return recordingId;
  }

  async function addPoster(recordingId: string) {
    await harness.db.insert(mediaAssets).values({
      recordingId,
      kind: 'poster',
      objectKey: `r/${recordingId}/poster.webp`,
      contentType: 'image/webp',
      bytes: 1024,
    });
  }

  // The worker has been producing these all along; nothing ever showed them,
  // which is why a library of recordings read as a list of filenames.
  it('gives the library a URL for each poster', async () => {
    const withPoster = await record('Has a thumbnail');
    await addPoster(withPoster);
    const withoutPoster = await record('Does not');

    const page = await harness.app.inject({
      method: 'GET',
      url: '/v1/recordings',
      headers: { cookie },
    });
    const rows: { id: string; posterUrl: string | null }[] = page.json().recordings;

    expect(rows.find((row) => row.id === withPoster)?.posterUrl).toMatch(/^https?:\/\//);
    // Null rather than absent: the card has a placeholder for exactly this.
    expect(rows.find((row) => row.id === withoutPoster)?.posterUrl).toBeNull();
  });

  it('gives the player a poster to open on', async () => {
    const id = await record('One recording');
    await addPoster(id);

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/${id}`,
      headers: { cookie },
    });

    expect(detail.json().posterUrl).toMatch(/^https?:\/\//);
  });
});
