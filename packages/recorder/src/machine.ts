import type { UploadSessionInfo } from './types.ts';

/**
 * The recorder as a state machine, written as a plain reducer over a union.
 * TypeScript checks the switch is exhaustive, which is most of what a state-chart
 * library would have been bought for.
 */
export type RecorderState =
  | { status: 'idle' }
  | { status: 'requestingCapture' }
  | { status: 'ready' }
  | { status: 'recording'; session: UploadSessionInfo; startedAt: number }
  | { status: 'paused'; session: UploadSessionInfo; startedAt: number }
  // Recording has stopped but parts are still going up. The interface says
  // "uploading the last few seconds" here instead of sitting at 99%.
  | { status: 'finalizing'; session: UploadSessionInfo; remainingParts: number }
  | { status: 'published'; recordingId: string }
  // What a tab crash resumes into: local parts exist and need reconciling with
  // whatever the server already has.
  | { status: 'recovering'; session: UploadSessionInfo }
  | { status: 'failed'; reason: string };

export type RecorderEvent =
  | { type: 'requestCapture' }
  | { type: 'captureGranted' }
  | { type: 'captureDenied'; reason: string }
  | { type: 'start'; session: UploadSessionInfo }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'partsRemaining'; count: number }
  | { type: 'published'; recordingId: string }
  | { type: 'recoverFound'; session: UploadSessionInfo }
  | { type: 'fail'; reason: string }
  | { type: 'reset' };

export const initialState: RecorderState = { status: 'idle' };

/** Unknown transitions return the state unchanged rather than throwing: an event
 *  arriving a moment late should be ignored, not crash a recording in progress. */
export function reduce(state: RecorderState, event: RecorderEvent): RecorderState {
  // Failing and resetting are always allowed, from anywhere.
  if (event.type === 'fail') return { status: 'failed', reason: event.reason };
  if (event.type === 'reset') return initialState;

  switch (state.status) {
    case 'idle':
      if (event.type === 'requestCapture') return { status: 'requestingCapture' };
      if (event.type === 'recoverFound') return { status: 'recovering', session: event.session };
      return state;

    case 'requestingCapture':
      if (event.type === 'captureGranted') return { status: 'ready' };
      if (event.type === 'captureDenied') return { status: 'failed', reason: event.reason };
      return state;

    case 'ready':
      if (event.type === 'start') {
        return { status: 'recording', session: event.session, startedAt: Date.now() };
      }
      return state;

    case 'recording':
      if (event.type === 'pause') return { ...state, status: 'paused' };
      if (event.type === 'stop') {
        return { status: 'finalizing', session: state.session, remainingParts: 0 };
      }
      return state;

    case 'paused':
      if (event.type === 'resume') return { ...state, status: 'recording' };
      if (event.type === 'stop') {
        return { status: 'finalizing', session: state.session, remainingParts: 0 };
      }
      return state;

    case 'finalizing':
      if (event.type === 'partsRemaining') return { ...state, remainingParts: event.count };
      if (event.type === 'published') return { status: 'published', recordingId: event.recordingId };
      // Stopping twice is what an impatient second click looks like.
      return state;

    case 'recovering':
      if (event.type === 'stop' || event.type === 'partsRemaining') {
        return { status: 'finalizing', session: state.session, remainingParts: 0 };
      }
      if (event.type === 'published') return { status: 'published', recordingId: event.recordingId };
      return state;

    case 'published':
    case 'failed':
      return state;
  }
}

/** True while the recorder is holding onto capture devices. */
export function isCapturing(state: RecorderState): boolean {
  return state.status === 'recording' || state.status === 'paused';
}

/** True while work is outstanding and the tab should warn before closing. */
export function hasUnfinishedWork(state: RecorderState): boolean {
  return isCapturing(state) || state.status === 'finalizing' || state.status === 'recovering';
}
