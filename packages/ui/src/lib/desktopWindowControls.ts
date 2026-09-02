import { getElectronPlatform, invokeDesktop, isDesktopShell, isElectronShell } from './desktopBridge';
import type {
  DesktopWindowControlAction,
  DesktopWindowControlsPosition,
  DesktopWindowControlsSide,
} from './desktopTypes';

/** Default side for in-app window controls (Windows-style, right). */
export const DEFAULT_DESKTOP_WINDOW_CONTROLS_POSITION: DesktopWindowControlsPosition = 'right';

/** Windows and Linux use frameless windows with in-app minimize/maximize/close controls. */
export const usesFramelessElectronChrome = (): boolean => {
  if (!isElectronShell()) return false;
  const platform = getElectronPlatform();
  return platform === 'win32' || platform === 'linux';
};

/** Normalize a stored preference; legacy `auto` maps to the right-side default. */
export const normalizeDesktopWindowControlsPosition = (
  value: unknown,
): DesktopWindowControlsPosition | undefined => {
  if (value === 'left' || value === 'right') {
    return value;
  }
  // Legacy "auto" never read OS chrome config; treat it as the right default.
  if (value === 'auto') {
    return DEFAULT_DESKTOP_WINDOW_CONTROLS_POSITION;
  }
  return undefined;
};

export const resolveDesktopWindowControlsSide = (
  preference: DesktopWindowControlsPosition | undefined,
): DesktopWindowControlsSide => {
  return preference === 'left' ? 'left' : DEFAULT_DESKTOP_WINDOW_CONTROLS_POSITION;
};

/**
 * Left matches macOS traffic-light order (close, minimize, maximize).
 * Right keeps Windows order (minimize, maximize, close).
 */
export const getDesktopWindowControlsOrder = (
  side: DesktopWindowControlsSide,
): DesktopWindowControlAction[] => {
  return side === 'left'
    ? ['close', 'minimize', 'maximize']
    : ['minimize', 'maximize', 'close'];
};

export const startDesktopWindowDrag = async (): Promise<boolean> => {
  if (!isDesktopShell()) {
    return false;
  }

  try {
    await invokeDesktop('desktop_start_window_drag');
    return true;
  } catch {
    return false;
  }
};
