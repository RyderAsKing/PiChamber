import { getElectronPlatform, invokeDesktop, isDesktopShell, isElectronShell } from './desktopBridge';

/** Windows and Linux use frameless windows with fixed right-side classic controls. */
export const usesFramelessElectronChrome = (): boolean => {
  if (!isElectronShell()) return false;
  const platform = getElectronPlatform();
  return platform === 'win32' || platform === 'linux';
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
