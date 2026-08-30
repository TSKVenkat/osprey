import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface MediaInfo {
  container: string;
  durationMs: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrateBps: number | null;
  bytes: number | null;
  hasAudio: boolean;
}

/** The shape of the ffprobe JSON we actually read. */
interface ProbeJson {
  format?: { format_name?: string; duration?: string; bit_rate?: string; size?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }[];
}

export function parseProbe(json: unknown): MediaInfo {
  const probe = json as ProbeJson;
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  // The container duration is missing on a streaming-written file, in which case a
  // stream's own duration is the next best thing.
  const seconds = Number(probe.format?.duration ?? video?.duration ?? audio?.duration);

  return {
    container: probe.format?.format_name ?? 'unknown',
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    bitrateBps: toNumber(probe.format?.bit_rate),
    bytes: toNumber(probe.format?.size),
    hasAudio: Boolean(audio),
  };
}

function toNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function probeFile(path: string): Promise<MediaInfo> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  return parseProbe(JSON.parse(stdout));
}

/**
 * Whether the index sits before the media data, which is what lets a player start
 * without downloading the whole file first.
 *
 * The boxes are walked rather than searched for by name, because the bytes "moov"
 * appear inside compressed video often enough to make a plain search wrong.
 */
export function moovIsAtTheFront(head: Buffer): boolean {
  let offset = 0;
  const order: string[] = [];

  while (offset + 8 <= head.length) {
    let size = head.readUInt32BE(offset);
    const name = head.subarray(offset + 4, offset + 8).toString('latin1');
    order.push(name);

    if (size === 1) {
      if (offset + 16 > head.length) break;
      size = Number(head.readBigUInt64BE(offset + 8));
    }
    if (size < 8) break;
    offset += size;
  }

  const moov = order.indexOf('moov');
  const mdat = order.indexOf('mdat');
  if (moov === -1) return false;
  // No mdat in the part we read means everything before it is index, which is the
  // arrangement we want.
  return mdat === -1 || moov < mdat;
}
