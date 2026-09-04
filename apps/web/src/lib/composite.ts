import {
  DEFAULT_POSITION,
  evenDimensions,
  placeBubble,
  squareCrop,
  type BubblePosition,
  type BubbleSize,
} from '@bilby/recorder';

export interface CompositeOptions {
  screen: MediaStream;
  camera: MediaStream | null;
  position?: BubblePosition;
  size?: BubbleSize;
  frameRate?: number;
}

/**
 * Draws the screen and the camera into one picture, and hands back a stream of it.
 *
 * The bubble has to be painted into the video rather than laid over the page,
 * because what gets recorded is this canvas. An overlay that only exists in the
 * browser would look right while recording and be missing from the file.
 */
export class Composite {
  readonly stream: MediaStream;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly screenVideo: HTMLVideoElement;
  private readonly cameraVideo: HTMLVideoElement | null;
  private position: BubblePosition;
  private size: BubbleSize;
  private running = true;
  private frame = 0;

  private constructor(options: {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    screenVideo: HTMLVideoElement;
    cameraVideo: HTMLVideoElement | null;
    stream: MediaStream;
    position: BubblePosition;
    size: BubbleSize;
  }) {
    this.canvas = options.canvas;
    this.context = options.context;
    this.screenVideo = options.screenVideo;
    this.cameraVideo = options.cameraVideo;
    this.stream = options.stream;
    this.position = options.position;
    this.size = options.size;
  }

  static async start(options: CompositeOptions): Promise<Composite> {
    const screenVideo = await playInvisibly(options.screen);
    const cameraVideo = options.camera ? await playInvisibly(options.camera) : null;

    // The recording takes the screen's own dimensions, so nothing is scaled and
    // text stays as sharp as it was on screen.
    const { width, height } = evenDimensions(
      screenVideo.videoWidth || 1280,
      screenVideo.videoHeight || 720,
    );

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser cannot compose the camera into the recording.');

    const stream = canvas.captureStream(options.frameRate ?? 30);

    const composite = new Composite({
      canvas,
      context,
      screenVideo,
      cameraVideo,
      stream,
      position: options.position ?? DEFAULT_POSITION,
      size: options.size ?? 'medium',
    });
    composite.draw();
    return composite;
  }

  /** Dragging the bubble is free: the next frame simply lands somewhere else. */
  moveTo(position: BubblePosition): void {
    this.position = position;
  }

  resize(size: BubbleSize): void {
    this.size = size;
  }

  get bubble(): { position: BubblePosition; size: BubbleSize } {
    return { position: this.position, size: this.size };
  }

  stop(): void {
    this.running = false;
    for (const track of this.stream.getTracks()) track.stop();
    this.screenVideo.srcObject = null;
    if (this.cameraVideo) this.cameraVideo.srcObject = null;
    this.screenVideo.remove();
    this.cameraVideo?.remove();
  }

  private draw = (): void => {
    if (!this.running) return;
    this.frame++;

    const { width, height } = this.canvas;
    this.context.drawImage(this.screenVideo, 0, 0, width, height);

    const camera = this.cameraVideo;
    if (camera && camera.videoWidth > 0) {
      const { centreX, centreY, radius } = placeBubble({ width, height }, this.position, this.size);
      const crop = squareCrop({ width: camera.videoWidth, height: camera.videoHeight });

      this.context.save();
      this.context.beginPath();
      this.context.arc(centreX, centreY, radius, 0, Math.PI * 2);
      this.context.clip();
      // Mirrored, because a self-view that moves the wrong way is disconcerting.
      // The screen behind it is not mirrored, only this circle.
      this.context.translate(centreX + radius, centreY - radius);
      this.context.scale(-1, 1);
      this.context.drawImage(
        camera,
        crop.sx,
        crop.sy,
        crop.sWidth,
        crop.sHeight,
        0,
        0,
        radius * 2,
        radius * 2,
      );
      this.context.restore();

      // A ring, so the bubble reads as deliberate against a busy screen.
      this.context.save();
      this.context.beginPath();
      this.context.arc(centreX, centreY, radius, 0, Math.PI * 2);
      this.context.lineWidth = Math.max(2, radius * 0.03);
      this.context.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      this.context.stroke();
      this.context.restore();
    }

    requestAnimationFrame(this.draw);
  };

  /** Frames drawn so far, for tests and diagnostics. */
  get framesDrawn(): number {
    return this.frame;
  }
}

/**
 * A video element playing a stream, off-screen.
 *
 * The element is what `drawImage` reads from; it must be playing, and must not be
 * `display: none`, because some browsers stop decoding frames for a hidden video
 * and the canvas then freezes on whatever it last saw.
 */
async function playInvisibly(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  Object.assign(video.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  });
  document.body.appendChild(video);

  await video.play();
  if (video.videoWidth === 0) {
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      setTimeout(resolve, 3000);
    });
  }
  return video;
}
