import { describe, expect, it } from 'vitest';
import {
  type RecorderState,
  hasUnfinishedWork,
  initialState,
  isCapturing,
  reduce,
} from './machine.ts';

const session = {
  recordingId: 'r1',
  uploadSessionId: 's1',
  partSize: 1024,
  capabilities: {
    directUpload: false,
    multipart: true,
    resumable: true,
    signedRead: true,
    rangeRequests: true,
    serverSideTranscode: false,
    adaptiveStreaming: false,
    minPartBytes: 1,
    maxPartBytes: 1024,
    maxObjectBytes: 1024,
  },
};

function walk(events: Parameters<typeof reduce>[1][]): RecorderState {
  return events.reduce(reduce, initialState);
}

describe('recorder state machine', () => {
  it('walks the ordinary path from idle to published', () => {
    const state = walk([
      { type: 'requestCapture' },
      { type: 'captureGranted' },
      { type: 'start', session },
      { type: 'stop' },
      { type: 'published', recordingId: 'r1' },
    ]);

    expect(state).toEqual({ status: 'published', recordingId: 'r1' });
  });

  it('stops at finalizing rather than jumping straight to done', () => {
    const state = walk([
      { type: 'requestCapture' },
      { type: 'captureGranted' },
      { type: 'start', session },
      { type: 'stop' },
    ]);

    // Pressing stop does not mean the upload is finished. This state is what lets the
    // interface say "sending the last few seconds" instead of sitting at 99%.
    expect(state.status).toBe('finalizing');
  });

  it('tracks how much is left while finalizing', () => {
    const state = walk([
      { type: 'requestCapture' },
      { type: 'captureGranted' },
      { type: 'start', session },
      { type: 'stop' },
      { type: 'partsRemaining', count: 3 },
    ]);

    expect(state).toMatchObject({ status: 'finalizing', remainingParts: 3 });
  });

  it('pauses and resumes', () => {
    const paused = walk([
      { type: 'requestCapture' },
      { type: 'captureGranted' },
      { type: 'start', session },
      { type: 'pause' },
    ]);
    expect(paused.status).toBe('paused');
    expect(reduce(paused, { type: 'resume' }).status).toBe('recording');
  });

  it('fails when capture is refused', () => {
    const state = walk([
      { type: 'requestCapture' },
      { type: 'captureDenied', reason: 'Permission denied' },
    ]);
    expect(state).toEqual({ status: 'failed', reason: 'Permission denied' });
  });

  it('enters recovery when local parts are found on startup', () => {
    const state = reduce(initialState, { type: 'recoverFound', session });
    expect(state).toEqual({ status: 'recovering', session });
  });

  it('finishes a recovered upload through the same finalizing path', () => {
    const state = walk([{ type: 'recoverFound', session }, { type: 'stop' }]);
    expect(state.status).toBe('finalizing');
  });

  it('ignores events that do not apply, rather than throwing', () => {
    // An event arriving a moment late should not take down a recording in progress.
    const recording = walk([
      { type: 'requestCapture' },
      { type: 'captureGranted' },
      { type: 'start', session },
    ]);
    expect(reduce(recording, { type: 'start', session })).toEqual(recording);
    expect(reduce(recording, { type: 'resume' })).toEqual(recording);
    expect(reduce(initialState, { type: 'stop' })).toEqual(initialState);
  });

  it('treats a second stop as a no-op', () => {
    const finalizing = walk([
      { type: 'requestCapture' },
      { type: 'captureGranted' },
      { type: 'start', session },
      { type: 'stop' },
    ]);
    expect(reduce(finalizing, { type: 'stop' })).toEqual(finalizing);
  });

  it('can fail from anywhere and reset from anywhere', () => {
    const recording = walk([
      { type: 'requestCapture' },
      { type: 'captureGranted' },
      { type: 'start', session },
    ]);
    expect(reduce(recording, { type: 'fail', reason: 'disk full' }).status).toBe('failed');
    expect(reduce(recording, { type: 'reset' })).toEqual(initialState);
  });

  it('will not move on from a terminal state', () => {
    const published: RecorderState = { status: 'published', recordingId: 'r1' };
    expect(reduce(published, { type: 'start', session })).toEqual(published);
  });

  it('knows when capture devices are held and when work is outstanding', () => {
    expect(isCapturing({ status: 'recording', session, startedAt: 0 })).toBe(true);
    expect(isCapturing({ status: 'finalizing', session, remainingParts: 1 })).toBe(false);

    // Closing the tab during any of these loses something.
    expect(hasUnfinishedWork({ status: 'finalizing', session, remainingParts: 1 })).toBe(true);
    expect(hasUnfinishedWork({ status: 'recovering', session })).toBe(true);
    expect(hasUnfinishedWork({ status: 'published', recordingId: 'r1' })).toBe(false);
  });
});
