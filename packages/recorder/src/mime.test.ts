import { describe, expect, it } from 'vitest';
import { MIME_PREFERENCE, pickMimeType, supportsSystemAudio } from './mime.ts';

describe('pickMimeType', () => {
  it('prefers MP4 when the browser can record it', () => {
    // Worth a whole second of remuxing instead of minutes of transcoding.
    expect(pickMimeType(() => true)).toBe(MIME_PREFERENCE[0]);
  });

  it('falls back through the list in order', () => {
    const webmOnly = (type: string) => type.startsWith('video/webm');
    expect(pickMimeType(webmOnly)).toBe('video/webm;codecs=vp9,opus');
  });

  it('picks H.264 with Opus on a browser that has no AAC', () => {
    // Chrome rejects every mp4a.40.2 string and pairs MP4 with Opus. Asking only
    // for AAC means never matching MP4 and falling through to WebM, which is the
    // difference between a seekable recording and one with no duration.
    const chrome = (type: string) => !type.includes('mp4a.40.2');
    expect(pickMimeType(chrome)).toBe('video/mp4;codecs=avc1.42E01E,opus');
  });

  it('prefers WebM over bare video/mp4', () => {
    // Chrome answers bare video/mp4 with VP9 in an MP4 container, which Safari
    // cannot play at all.
    const noCodecStrings = (type: string) => !type.includes('codecs');
    expect(pickMimeType(noCodecStrings)).toBe('video/webm');
  });

  it('returns null when nothing is supported', () => {
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe('supportsSystemAudio', () => {
  it('recognises Chromium browsers', () => {
    expect(supportsSystemAudio('Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36')).toBe(true);
    expect(supportsSystemAudio('Mozilla/5.0 Chrome/120 Edg/120.0.0.0')).toBe(true);
  });

  it('rules out Firefox and Safari', () => {
    // Both accept the audio constraint and hand back a silent track, which is worse
    // than refusing, so the interface has to know not to offer it.
    expect(supportsSystemAudio('Mozilla/5.0 Firefox/130.0')).toBe(false);
    expect(supportsSystemAudio('Mozilla/5.0 Version/17.0 Safari/605.1.15')).toBe(false);
  });
});
