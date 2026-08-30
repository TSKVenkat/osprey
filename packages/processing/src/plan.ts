import type { MediaInfo } from './probe.ts';

export type PlanKind = 'reuse' | 'remux' | 'transcode-audio' | 'transcode';

export interface Plan {
  kind: PlanKind;
  /** Why, in a form that can go straight into a log line. */
  reason: string;
}

/** What plays everywhere without a player library or a polyfill. */
const DELIVERY_VIDEO = 'h264';
const DELIVERY_AUDIO = 'aac';

/**
 * Decides how much work a recording actually needs.
 *
 * The tiers matter because they differ by orders of magnitude. Re-encoding video is
 * minutes of CPU per recording; re-encoding audio is seconds; moving the index is
 * about a second; doing nothing is free. Browsers hand us all four cases, so the
 * cheapest correct answer is worth choosing deliberately rather than transcoding
 * everything and paying for the worst case every time.
 */
export function planFor(
  info: MediaInfo,
  options: {
    moovAtFront: boolean;
    /**
     * The recording was recovered after the tab died, so its last fragment is
     * probably incomplete. ffprobe cannot see this: a truncated fragmented MP4
     * still reports the duration its header claims. Rebuilding it is the only way
     * to be sure a player will not hit the missing bytes and give up.
     */
    interrupted?: boolean;
  },
): Plan {
  const isMp4 = info.container.includes('mp4') || info.container.includes('mov');
  const videoOk = info.videoCodec === DELIVERY_VIDEO;
  const audioOk = !info.hasAudio || info.audioCodec === DELIVERY_AUDIO;

  if (!videoOk) {
    return {
      kind: 'transcode',
      reason: `video is ${info.videoCodec ?? 'unknown'}, which not every browser can play`,
    };
  }

  if (!audioOk) {
    // What Chrome produces: H.264 video it can keep, Opus audio Safari cannot play.
    return {
      kind: 'transcode-audio',
      reason: `video is already ${DELIVERY_VIDEO}; only the ${info.audioCodec} audio needs converting`,
    };
  }

  if (!isMp4) {
    return { kind: 'remux', reason: `${info.container} repackaged as mp4, without re-encoding` };
  }

  if (!options.moovAtFront) {
    return { kind: 'remux', reason: 'index moved to the front so playback can start immediately' };
  }

  if (options.interrupted) {
    return {
      kind: 'remux',
      reason: 'recording was interrupted, so it is rebuilt rather than trusted',
    };
  }

  return { kind: 'reuse', reason: 'already h264 and aac in mp4 with the index at the front' };
}

export interface EncodeOptions {
  input: string;
  output: string;
}

/**
 * ffmpeg arguments, built explicitly rather than through a wrapper. The exact
 * arguments are the thing worth reviewing here, so they are visible and snapshot
 * tested instead of assembled behind an API.
 */
export function ffmpegArgs(plan: PlanKind, { input, output }: EncodeOptions): string[] {
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
  // Puts the index at the front. Without it a player has to fetch the whole file
  // before it can show a single frame.
  const faststart = ['-movflags', '+faststart'];

  switch (plan) {
    case 'reuse':
      throw new Error('Nothing to run: the original is already deliverable.');

    case 'remux':
      // Streams copied verbatim; only the container changes.
      return [...common, '-c', 'copy', ...faststart, output];

    case 'transcode-audio':
      return [...common, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', ...faststart, output];

    case 'transcode':
      return [
        ...common,
        '-c:v',
        'libx264',
        // veryfast keeps a worker from becoming the bottleneck; crf 23 is visually
        // clean for screen content, which compresses well to begin with.
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        ...faststart,
        output,
      ];
  }
}

/** A single frame, for the thumbnail. */
export function posterArgs({
  input,
  output,
  atMs,
}: EncodeOptions & { atMs: number }): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    // Seeking before the input is far faster: ffmpeg jumps rather than decoding
    // everything up to that point.
    '-ss',
    (atMs / 1000).toFixed(3),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    'scale=640:-2',
    output,
  ];
}

/** Far enough in to miss a blank first frame, but never past the end. */
export function posterPositionMs(durationMs: number | null): number {
  if (!durationMs || durationMs <= 0) return 0;
  return Math.min(3000, Math.floor(durationMs / 2));
}
