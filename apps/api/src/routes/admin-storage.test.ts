import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storageConfigs } from '@osprey/db';

import {
  TEST_ADMIN,
  type Harness,
  configureLocalStorage,
  createHarness,
  createUserAndLogin,
  login,
} from '../testing/harness.ts';

describe('admin storage', () => {
  let harness: Harness;
  let cookie: string;

  beforeEach(async () => {
    harness = await createHarness();
    cookie = await login(harness.app, TEST_ADMIN);
  });

  afterEach(async () => {
    await harness.close();
  });

  it('is closed to ordinary users', async () => {
    const member = await createUserAndLogin(harness.app, cookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/admin/storage',
      headers: { cookie: member.cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it('never returns credentials, not even to an admin', async () => {
    await configureLocalStorage(harness, cookie);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/admin/storage',
      headers: { cookie },
    });

    for (const field of ['secretCt', 'secretIv', 'secretTag', 'secretAccessKey']) {
      expect(response.body).not.toContain(field);
    }
  });

  it('encrypts credentials at rest', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/storage',
      headers: { cookie },
      payload: {
        kind: 's3',
        label: 'Bucket',
        config: { bucket: 'osprey', region: 'us-east-1', endpoint: 'http://127.0.0.1:1' },
        secret: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'super-secret-value' },
      },
    });

    // No bucket is listening, so saving is refused before anything is written. That
    // is the point: a configuration is proven usable before it is accepted.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('STORAGE_TEST_FAILED');

    const rows = await harness.db.select().from(storageConfigs);
    expect(rows).toHaveLength(0);
  });

  it('rejects a configuration it cannot actually write to', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/storage',
      headers: { cookie },
      // A path under a file rather than a directory: fails with ENOTDIR straight away.
      payload: { kind: 'local', label: 'Unwritable', config: { root: '/dev/null/osprey' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('STORAGE_TEST_FAILED');
  });

  it('keeps exactly one default when the default is switched', async () => {
    await configureLocalStorage(harness, cookie);
    const secondRoot = await mkdtemp(join(tmpdir(), 'osprey-second-'));

    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/storage',
      headers: { cookie },
      payload: { kind: 'local', label: 'Second disk', config: { root: secondRoot } },
    });
    await harness.app.inject({
      method: 'POST',
      url: `/v1/admin/storage/${created.json().storage.id}/default`,
      headers: { cookie },
    });

    const rows = await harness.db.select().from(storageConfigs);
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    expect(rows.find((r) => r.isDefault)?.label).toBe('Second disk');
  });

  it('will not remove the default configuration', async () => {
    const id = await configureLocalStorage(harness, cookie);

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/admin/storage/${id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('STORAGE_IN_USE');
  });
});

describe('saving storage and actually using it', () => {
  let harness: Harness;
  let cookie: string;

  beforeEach(async () => {
    harness = await createHarness();
    cookie = await login(harness.app, TEST_ADMIN);
  });

  afterEach(async () => {
    await harness.close();
  });

  function add(payload: Record<string, unknown>) {
    return harness.app.inject({
      method: 'POST',
      url: '/v1/admin/storage',
      headers: { cookie },
      payload: { kind: 'local', label: 'Disk', config: { root: harness.storageRoot }, ...payload },
    });
  }

  it('uses the first backend configured, without being asked', async () => {
    // An instance whose only storage is not being used is not a working instance.
    const response = await add({});
    expect(response.json().storage.isDefault).toBe(true);
  });

  it('switches to a new backend when asked to', async () => {
    await add({});
    const second = await add({ label: 'Second disk', makeDefault: true });

    expect(second.json().storage.isDefault).toBe(true);
    const rows = await harness.db.select().from(storageConfigs);
    // Exactly one, always: the partial unique index would reject anything else.
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
    expect(rows.find((row) => row.isDefault)?.label).toBe('Second disk');
  });

  it('leaves the current backend alone when not asked', async () => {
    await add({ label: 'First disk' });
    const second = await add({ label: 'Spare disk', makeDefault: false });

    // Saving a second backend must not silently move where recordings go.
    expect(second.json().storage.isDefault).toBe(false);
    const rows = await harness.db.select().from(storageConfigs);
    expect(rows.find((row) => row.isDefault)?.label).toBe('First disk');
  });
});
