import { useEffect, useRef, useState } from 'react';

/**
 * A self-view before recording starts, so the presenter can frame themselves
 * rather than discovering afterwards that the bubble was pointing at the ceiling.
 *
 * The circle here matches the one drawn into the recording, mirroring included.
 */
export function CameraPreview({ deviceId, enabled }: { deviceId?: string; enabled: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      })
      .then((opened) => {
        if (cancelled) {
          for (const track of opened.getTracks()) track.stop();
          return;
        }
        stream = opened;
        if (video.current) {
          video.current.srcObject = opened;
          void video.current.play().catch(() => {});
        }
      })
      .catch(() => setError('That camera is unavailable. Recording will continue without it.'));

    return () => {
      cancelled = true;
      // Released as soon as the preview goes away, so the camera light does not
      // stay on while somebody fills in a title.
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [deviceId, enabled]);

  if (!enabled) return null;
  if (error) return <p className="warn small">{error}</p>;

  return (
    <div className="camera-preview">
      <video ref={video} muted playsInline />
      <span className="muted small">This is what appears in the corner of the recording.</span>
    </div>
  );
}
