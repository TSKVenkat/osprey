/**
 * A small always-on-top window for the recording controls.
 *
 * While recording a whole screen the recorder tab is behind whatever is being
 * demonstrated, so controls on the page are unreachable without switching away
 * from the thing being recorded — which the recording then shows. Document
 * picture-in-picture is the only way a browser can put real, clickable controls
 * above every other window.
 *
 * Chrome and Edge have it. Firefox and Safari do not, and there fall back to the
 * controls on the page.
 */

interface DocumentPictureInPicture {
  requestWindow(options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
    preferInitialWindowPlacement?: boolean;
  }): Promise<Window>;
  window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export function floatingControlsAvailable(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

/**
 * Copies the page's styles into the new window.
 *
 * A picture-in-picture window is a separate document and inherits nothing, so
 * without this the controls arrive completely unstyled.
 */
function copyStyles(target: Window): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const cssText = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
      const style = target.document.createElement('style');
      style.textContent = cssText;
      target.document.head.append(style);
    } catch {
      // A cross-origin stylesheet cannot be read. Link it instead and let the new
      // window fetch it itself.
      if (!sheet.href) continue;
      const link = target.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      target.document.head.append(link);
    }
  }
}

export interface FloatingWindow {
  window: Window;
  container: HTMLElement;
  close: () => void;
}

export async function openFloatingControls(options: {
  width?: number;
  height?: number;
  onClose?: () => void;
}): Promise<FloatingWindow | null> {
  if (!floatingControlsAvailable()) return null;

  const pip = await window.documentPictureInPicture!.requestWindow({
    width: options.width ?? 260,
    height: options.height ?? 320,
    // Returning to the opener would switch away from what is being recorded,
    // which is the problem this window exists to avoid.
    disallowReturnToOpener: true,
  });

  copyStyles(pip);
  pip.document.body.classList.add('pip-body');

  const container = pip.document.createElement('div');
  container.className = 'pip-root';
  pip.document.body.append(container);

  if (options.onClose) pip.addEventListener('pagehide', options.onClose, { once: true });

  return {
    window: pip,
    container,
    close: () => pip.close(),
  };
}
