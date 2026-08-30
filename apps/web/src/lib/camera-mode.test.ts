import { describe, expect, it } from 'vitest';
import { chooseCameraMode } from './capture.ts';

/**
 * How the camera reaches the recording.
 *
 * Getting this wrong is not a visible bug at the time: a floating window over a
 * shared tab looks perfectly fine on screen and is simply absent from the file,
 * and nobody finds out until they watch it back.
 */
describe('chooseCameraMode', () => {
  it('puts the camera in a window when the whole screen is shared', () => {
    // The window is genuinely on the screen, so it is genuinely in the recording,
    // and dragging it moves the presenter.
    expect(chooseCameraMode({ camera: true, surface: 'monitor', canFloat: true })).toBe('on-screen');
  });

  it('paints the camera in when only one window is shared', () => {
    // A floating bubble is not inside another window's capture.
    expect(chooseCameraMode({ camera: true, surface: 'window', canFloat: true })).toBe('composited');
  });

  it('paints the camera in when only a tab is shared', () => {
    expect(chooseCameraMode({ camera: true, surface: 'browser', canFloat: true })).toBe(
      'composited',
    );
  });

  it('paints the camera in when the browser has no floating window', () => {
    // Firefox and Safari have no document picture-in-picture, so the bubble has
    // to be part of the picture or there is no bubble at all.
    expect(chooseCameraMode({ camera: true, surface: 'monitor', canFloat: false })).toBe(
      'composited',
    );
  });

  it('paints the camera in when the browser will not say what is shared', () => {
    // Assuming a monitor on a maybe would silently drop the camera from the file.
    expect(chooseCameraMode({ camera: true, surface: 'unknown', canFloat: true })).toBe(
      'composited',
    );
  });

  it('does nothing at all without a camera', () => {
    for (const surface of ['monitor', 'window', 'browser', 'unknown'] as const) {
      expect(chooseCameraMode({ camera: false, surface, canFloat: true })).toBe('none');
    }
  });
});
