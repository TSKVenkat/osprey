/**
 * MP4 first, and the exact codec strings matter.
 *
 * Measured in Chrome 148: a WebM recording comes back with `duration: Infinity`
 * and no seek index, which is the broken-scrubber bug. The same recording as MP4
 * reports its real duration and seeks immediately. So this ordering is not a
 * nicety, it decides whether a recording is watchable before it is processed.
 *
 * Two traps are encoded here:
 *
 * - Chrome has no AAC in MediaRecorder. Every `mp4a.40.2` combination is rejected,
 *   and it pairs MP4 with Opus instead. Asking only for the AAC string means never
 *   matching MP4 at all and silently falling through to WebM. The AAC entry stays
 *   first because Safari does support it, and H.264 with AAC needs nothing but a
 *   faststart remux on the server.
 * - Bare `video/mp4` is answered by Chrome with VP9 in an MP4 container. It plays
 *   in Chromium and Firefox but not in Safari, so it sits last: a plain WebM is a
 *   more honest fallback than an MP4 that only some browsers can open.
 */
export const MIME_PREFERENCE = [
  // Safari. H.264 and AAC: the server only has to move the index to the front.
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  // Chrome and Edge. H.264 video, so only the audio needs converting later.
  'video/mp4;codecs=avc1.42E01E,opus',
  'video/mp4;codecs=avc1.42E01E',
  // WebM: a full video transcode later, and no duration until that happens.
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  // Last resort. See the note above about VP9 in MP4.
  'video/mp4',
] as const;

export type SupportCheck = (mimeType: string) => boolean;

/**
 * The support check is injected rather than read from MediaRecorder directly, so
 * this stays testable outside a browser and so a caller can override the order.
 */
export function pickMimeType(
  isSupported: SupportCheck,
  preference: readonly string[] = MIME_PREFERENCE,
): string | null {
  return preference.find((type) => isSupported(type)) ?? null;
}

export function browserSupportCheck(): SupportCheck {
  if (typeof MediaRecorder === 'undefined') return () => false;
  return (type) => MediaRecorder.isTypeSupported(type);
}

/**
 * Firefox and Safari accept an audio constraint on getDisplayMedia and hand back a
 * silent track. Rather than shipping a silent recording, the recorder asks first and
 * the interface says plainly when system audio is not available.
 */
export function supportsSystemAudio(userAgent: string): boolean {
  const isChromium = /Chrome|Chromium|Edg/.test(userAgent) && !/OPR|Firefox/.test(userAgent);
  return isChromium;
}
