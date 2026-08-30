import { describe, expect, it } from 'vitest';
import { ffmpegArgs, planFor, posterArgs, posterPositionMs } from './plan.ts';
import type { MediaInfo } from './probe.ts';

const base: MediaInfo = {
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs: 9000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1280,
  height: 720,
  bitrateBps: 400_000,
  bytes: 450_000,
  hasAudio: true,
};

describe('planFor', () => {
  it('does nothing when the recording is already deliverable', () => {
    // What Safari produces: H.264 and AAC in MP4. Free.
    expect(planFor(base, { moovAtFront: true }).kind).toBe('reuse');
  });

  it('converts only the audio when the video is already H.264', () => {
    // What Chrome produces. Seconds of work rather than minutes, because the video
    // is copied through untouched.
    const plan = planFor({ ...base, audioCodec: 'opus' }, { moovAtFront: true });
    expect(plan.kind).toBe('transcode-audio');
    expect(plan.reason).toMatch(/only the opus audio/);
  });

  it('re-encodes when the video codec is not playable everywhere', () => {
    const plan = planFor(
      { ...base, container: 'matroska,webm', videoCodec: 'vp9', audioCodec: 'opus' },
      { moovAtFront: false },
    );
    expect(plan.kind).toBe('transcode');
  });

  it('repackages a WebM that happens to hold H.264', () => {
    const plan = planFor(
      { ...base, container: 'matroska,webm', audioCodec: 'aac' },
      { moovAtFront: false },
    );
    expect(plan.kind).toBe('remux');
  });

  it('moves the index when it sits behind the media', () => {
    const plan = planFor(base, { moovAtFront: false });
    expect(plan.kind).toBe('remux');
    expect(plan.reason).toMatch(/index moved/);
  });

  it('ignores audio codecs on a recording with no audio', () => {
    const silent = { ...base, hasAudio: false, audioCodec: null };
    expect(planFor(silent, { moovAtFront: true }).kind).toBe('reuse');
  });
});

describe('ffmpegArgs', () => {
  const paths = { input: '/tmp/in.webm', output: '/tmp/out.mp4' };

  it('copies both streams for a remux', () => {
    expect(ffmpegArgs('remux', paths)).toEqual([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', '/tmp/in.webm',
      '-c', 'copy', '-movflags', '+faststart', '/tmp/out.mp4',
    ]);
  });

  it('copies the video and re-encodes only the audio', () => {
    const args = ffmpegArgs('transcode-audio', paths);
    expect(args).toContain('-c:v');
    expect(args.at(args.indexOf('-c:v') + 1)).toBe('copy');
    expect(args.at(args.indexOf('-c:a') + 1)).toBe('aac');
  });

  it('re-encodes both streams for a full transcode', () => {
    const args = ffmpegArgs('transcode', paths);
    expect(args.at(args.indexOf('-c:v') + 1)).toBe('libx264');
    expect(args).toContain('yuv420p');
  });

  it('always puts the index at the front', () => {
    for (const kind of ['remux', 'transcode-audio', 'transcode'] as const) {
      expect(ffmpegArgs(kind, paths)).toContain('+faststart');
    }
  });

  it('refuses to build a command for a recording that needs no work', () => {
    expect(() => ffmpegArgs('reuse', paths)).toThrow(/already deliverable/);
  });
});

describe('poster', () => {
  it('seeks before the input, which is the fast way round', () => {
    const args = posterArgs({ input: '/tmp/in.mp4', output: '/tmp/out.webp', atMs: 3000 });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });

  it('takes a frame from the middle of a short recording', () => {
    expect(posterPositionMs(4000)).toBe(2000);
  });

  it('never seeks past three seconds on a long one', () => {
    expect(posterPositionMs(600_000)).toBe(3000);
  });

  it('falls back to the first frame when the duration is unknown', () => {
    expect(posterPositionMs(null)).toBe(0);
  });
});
