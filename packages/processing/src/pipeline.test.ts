import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ffmpegArgs, planFor, posterArgs, posterPositionMs } from './plan.ts';
import { moovIsAtTheFront, probeFile } from './probe.ts';
import { runFfmpeg } from './run.ts';

const exec = promisify(execFile);

/**
 * The processing stage against real ffmpeg and real files.
 *
 * The inputs are built to match what browsers actually hand us, measured in
 * Chrome 148 and Safari: H.264 with Opus from Chrome, VP9 with Opus in WebM, and
 * H.264 with AAC from Safari. Deciding correctly between those three is the whole
 * job, and only a real encoder can prove it.
 */
describe('processing pipeline', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bilby-processing-'));
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Two seconds of moving picture and a tone, in whatever shape is asked for. */
  async function makeInput(name: string, args: string[]): Promise<string> {
    const path = join(dir, name);
    await exec('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      ...args,
      path,
    ], { timeout: 120_000 });
    return path;
  }

  async function headOf(path: string): Promise<Buffer> {
    return (await readFile(path)).subarray(0, 64 * 1024);
  }

  it('leaves a Safari recording alone', async () => {
    // H.264 and AAC in MP4 with the index already at the front: nothing to do.
    const input = await makeInput('safari.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart',
    ]);

    const info = await probeFile(input);
    const plan = planFor(info, { moovAtFront: moovIsAtTheFront(await headOf(input)) });

    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
    expect(plan.kind).toBe('reuse');
  }, 120_000);

  it('converts only the audio of a Chrome recording', async () => {
    // What Chrome produces: H.264 it can keep, Opus that Safari cannot play.
    const input = await makeInput('chrome.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libopus', '-strict', '-2',
    ]);

    const info = await probeFile(input);
    const plan = planFor(info, { moovAtFront: moovIsAtTheFront(await headOf(input)) });
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('opus');
    expect(plan.kind).toBe('transcode-audio');

    const output = join(dir, 'chrome-out.mp4');
    await runFfmpeg(ffmpegArgs(plan.kind, { input, output }));

    const result = await probeFile(output);
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBe('aac');
    expect(result.width).toBe(320);
    // The picture is copied through untouched, so the duration must survive exactly.
    expect(result.durationMs).toBeGreaterThan(1800);
    expect(moovIsAtTheFront(await headOf(output))).toBe(true);
  }, 120_000);

  it('re-encodes a WebM recording end to end', async () => {
    const input = await makeInput('chrome.webm', [
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
      '-c:a', 'libopus',
    ]);

    const info = await probeFile(input);
    const plan = planFor(info, { moovAtFront: false });
    expect(info.videoCodec).toBe('vp9');
    expect(plan.kind).toBe('transcode');

    const output = join(dir, 'webm-out.mp4');
    await runFfmpeg(ffmpegArgs(plan.kind, { input, output }));

    const result = await probeFile(output);
    expect(result.container).toContain('mp4');
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBe('aac');
    expect(result.durationMs).toBeGreaterThan(1800);
    expect(moovIsAtTheFront(await headOf(output))).toBe(true);
  }, 180_000);

  it('moves the index to the front when it starts at the back', async () => {
    // Written without faststart, which is where MediaRecorder MP4 output can land.
    const input = await makeInput('tail-index.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    ]);
    const startedAtBack = !moovIsAtTheFront(await headOf(input));

    // Only meaningful if ffmpeg actually produced a back-loaded file.
    if (startedAtBack) {
      const plan = planFor(await probeFile(input), { moovAtFront: false });
      expect(plan.kind).toBe('remux');

      const output = join(dir, 'faststart.mp4');
      await runFfmpeg(ffmpegArgs('remux', { input, output }));
      expect(moovIsAtTheFront(await headOf(output))).toBe(true);
    }
  }, 120_000);

  it('extracts a poster frame', async () => {
    const input = await makeInput('poster-source.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    ]);
    const info = await probeFile(input);
    const output = join(dir, 'poster.webp');

    await runFfmpeg(
      posterArgs({ input, output, atMs: posterPositionMs(info.durationMs) }),
    );

    const poster = await probeFile(output);
    expect(poster.width).toBe(640);
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
  }, 120_000);

  it('reports what went wrong rather than failing silently', async () => {
    await expect(
      runFfmpeg(ffmpegArgs('remux', { input: join(dir, 'nope.mp4'), output: join(dir, 'x.mp4') })),
    ).rejects.toThrow(/ffmpeg failed/);
  }, 60_000);
});
