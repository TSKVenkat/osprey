/**
 * MP4 first, deliberately.
 *
 * An H.264/AAC MP4 needs only its index moved to the front — a remux that takes
 * about a second and no re-encoding. A VP9/Opus WebM needs a full transcode, which
 * is minutes of CPU per recording. Preferring MP4 at capture time moves that work
 * off the server for free, on the browsers that can do it.
 *
 * WebM stays ahead of bare "video/mp4" because naming the codecs is the only way to
 * know what we are actually getting.
 */
export const MIME_PREFERENCE = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
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
