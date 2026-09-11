export const isTrayWindowBehaviorSupported = (platform) => (
  platform === 'win32' || platform === 'linux'
);

export const readMinimizeToTrayEnabled = (settings) => (
  settings?.desktopMinimizeToTrayEnabled === true
);

export const readCloseToTrayEnabled = (settings) => {
  if (typeof settings?.desktopCloseToTrayEnabled === 'boolean') {
    return settings.desktopCloseToTrayEnabled;
  }

  if (typeof settings?.desktopMinimizeToTrayEnabled === 'boolean') {
    return settings.desktopMinimizeToTrayEnabled;
  }

  return true;
};
