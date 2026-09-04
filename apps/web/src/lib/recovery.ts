import {
  UploadScheduler,
  type Part,
  type PartStore,
  type RecoveryPlan,
  type StoredManifest,
  createTransport,
  describeRecovery,
  isStale,
  planRecovery,
} from '@bilby/recorder';

import { ApiError, api, uploadApiFor } from './api.ts';
import { chooseStore } from './capture.ts';

export interface PendingRecovery {
  manifest: StoredManifest;
  plan: RecoveryPlan;
  description: string;
}

/**
 * Anything a previous tab left behind.
 *
 * The server is asked what it actually holds rather than trusting the local
 * manifest, because the tab died somewhere between writing a part and hearing that
 * it arrived, and only the server knows which.
 */
export async function findRecoverable(store: PartStore = chooseStore().store): Promise<
  PendingRecovery[]
> {
  const manifests = await store.loadManifests();
  const found: PendingRecovery[] = [];

  for (const manifest of manifests) {
    if (manifest.state === 'done') {
      await store.deleteRecording(manifest.recordingId);
      continue;
    }
    if (isStale(manifest)) {
      // Old enough that whoever made it has moved on. Offering it back would be
      // confusing, and keeping the bytes wastes the browser's storage quota.
      await discard(manifest, store).catch(() => undefined);
      continue;
    }

    const localParts = await store.list(manifest.recordingId);
    const tail = await store.getTail(manifest.recordingId);
    const remote = await api
      .getUploadSession(manifest.uploadSessionId)
      .catch((error: unknown) => {
        if (error instanceof ApiError && (error.status === 404 || error.status === 401)) return null;
        throw error;
      });

    const plan = planRecovery(manifest, localParts, remote, Boolean(tail));
    if (plan.action === 'discard') {
      await discard(manifest, store).catch(() => undefined);
      continue;
    }

    found.push({ manifest, plan, description: describeRecovery(manifest, plan) });
  }

  return found;
}

/**
 * Sends whatever is still missing and commits the upload. The same transport and
 * scheduler the live recording used, so a resumed part goes up exactly the way an
 * ordinary one does.
 */
export async function resume(
  pending: PendingRecovery,
  store: PartStore = chooseStore().store,
): Promise<{ recordingId: string }> {
  const { manifest, plan } = pending;

  if (plan.action === 'resume') {
    const transport = createTransport({
      api: uploadApiFor(),
      store,
      recordingId: manifest.recordingId,
      sessionId: manifest.uploadSessionId,
    });
    const scheduler = new UploadScheduler({ transport, concurrency: 2 });

    for (const partNumber of plan.partNumbers) {
      const blob = await store.get(manifest.recordingId, partNumber);
      // A part the manifest lists but the disk has lost cannot be recovered, and
      // the commit will refuse the gap rather than storing a broken file.
      if (!blob) continue;
      const part: Part = { partNumber, blob, bytes: blob.size, isLast: false };
      scheduler.enqueue(part);
    }

    // Whatever was recorded after the last whole part goes up as the final one.
    if (plan.tailPartNumber) {
      const tail = await store.getTail(manifest.recordingId);
      if (tail) {
        scheduler.enqueue({
          partNumber: plan.tailPartNumber,
          blob: tail,
          bytes: tail.size,
          isLast: true,
        });
      }
    }
    scheduler.close();

    const { failures } = await scheduler.run();
    if (failures.length > 0) {
      throw new Error(`${failures.length} part(s) still could not be uploaded.`);
    }
  }

  // Flagged so processing rebuilds the container: a recording whose tab died ends
  // mid-fragment, and a player that reaches the missing bytes simply stops.
  await api.completeUpload(manifest.uploadSessionId, { interrupted: true });
  await store.deleteRecording(manifest.recordingId);
  return { recordingId: manifest.recordingId };
}

export async function discard(
  manifest: StoredManifest,
  store: PartStore = chooseStore().store,
): Promise<void> {
  // Told to the server as well, so the parts it is holding are released rather than
  // waiting for the sweeper to notice them.
  await api.abortUpload(manifest.uploadSessionId).catch(() => undefined);
  await store.deleteRecording(manifest.recordingId);
}
