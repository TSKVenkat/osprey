import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class FfmpegFailed extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(args: string[], stderr: string) {
    super(`ffmpeg failed: ${stderr.split('\n').slice(-3).join(' ').trim() || 'no output'}`);
    this.name = 'FfmpegFailed';
    this.args = args;
    this.stderr = stderr;
  }
}

/**
 * Runs ffmpeg with an explicit argument list. Never through a shell, so a filename
 * can never be read as part of the command.
 */
export async function runFfmpeg(args: string[], timeoutMs = 30 * 60_000): Promise<void> {
  try {
    await exec('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new FfmpegFailed(args, String((error as { stderr?: string }).stderr ?? error));
  }
}
