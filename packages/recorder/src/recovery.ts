import type { StoredManifest } from './store.ts';

export interface RemoteSession {
  state: string;
  parts: { partNumber: number; bytes: number }[];
}

export type RecoveryPlan =
  /** Everything landed before the tab died; the upload just needs committing. */
  | { action: 'complete' }
  /**
   * Some parts are on disk and were never acknowledged. `tailPartNumber` is set
   * when the bytes recorded since the last whole part are also still on disk and
   * should go up as one final part.
   */
  | { action: 'resume'; partNumbers: number[]; tailPartNumber?: number }
  /** Nothing can be salvaged, and the leftovers should go. */
  | { action: 'discard'; reason: string };

/**
 * Decides what to do with a recording left behind by a tab that died.
 *
 * The server's part table is the truth and the local manifest is a hint. That
 * asymmetry is deliberate: the two will disagree, because the tab died somewhere
 * between writing a part to disk and hearing that it arrived, and only one of them
 * is authoritative about what the server holds.
 */
export function planRecovery(
  manifest: StoredManifest,
  localPartNumbers: number[],
  remote: RemoteSession | null,
  hasTail = false,
): RecoveryPlan {
  if (!remote) {
    return { action: 'discard', reason: 'The server no longer has this upload.' };
  }
  if (remote.state === 'done') {
    return { action: 'discard', reason: 'This recording was already finished.' };
  }
  if (remote.state !== 'uploading') {
    return { action: 'discard', reason: `The upload was ${remote.state}.` };
  }

  const acknowledged = new Set(remote.parts.map((part) => part.partNumber));
  const pending = localPartNumbers.filter((partNumber) => !acknowledged.has(partNumber));

  // The tail goes last, after every part that already exists on either side.
  const highestKnown = Math.max(0, ...acknowledged, ...localPartNumbers);
  const tailPartNumber = hasTail ? highestKnown + 1 : undefined;

  if (pending.length > 0 || tailPartNumber) {
    return {
      action: 'resume',
      partNumbers: [...pending].sort((a, b) => a - b),
      ...(tailPartNumber ? { tailPartNumber } : {}),
    };
  }

  if (acknowledged.size === 0) {
    // Nothing on either side: the tab died before a single part was written.
    return { action: 'discard', reason: 'Nothing was recorded before the interruption.' };
  }

  // Parts must be exactly 1..n before the server will accept a commit, and a
  // recording missing its middle is not worth offering to recover.
  const highest = Math.max(...acknowledged);
  if (acknowledged.size !== highest) {
    return {
      action: 'discard',
      reason: 'Part of this recording was lost before it reached the server.',
    };
  }

  return { action: 'complete' };
}

/** Old enough that whoever made it has moved on. */
export function isStale(manifest: StoredManifest, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000) {
  return now - manifest.startedAt > maxAgeMs;
}

export function describeRecovery(manifest: StoredManifest, plan: RecoveryPlan): string {
  const bytes = manifest.parts.reduce((total, part) => total + part.bytes, 0);
  const megabytes = (bytes / (1024 * 1024)).toFixed(1);

  switch (plan.action) {
    case 'complete':
      return 'An unfinished recording is ready to be saved.';
    case 'resume':
      return bytes > 0
        ? `An unfinished recording has ${megabytes} MB still to upload.`
        : 'An unfinished recording is waiting to be sent.';
    case 'discard':
      return plan.reason;
  }
}
