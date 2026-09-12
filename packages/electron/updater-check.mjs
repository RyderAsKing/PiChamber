const MISSING_UPDATE_FEED_RE =
  /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i;

export const isMissingUpdateFeedError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_UPDATE_FEED_RE.test(message);
};

export const checkForDesktopUpdate = async ({
  autoUpdater,
  currentVersion,
  pendingUpdate,
  compareVersions,
  updateChecks = null,
}) => {
  const checks = updateChecks?.length ? updateChecks : [null];
  for (const check of checks) {
    if (check) {
      autoUpdater.allowPrerelease = check.allowPrerelease;
      autoUpdater.channel = check.channel;
      // electron-updater enables downgrades whenever channel is assigned.
      autoUpdater.allowDowngrade = false;
    }

    let updateResult;
    try {
      updateResult = await autoUpdater.checkForUpdates();
    } catch (error) {
      // A channel has no updates until its first manifest is published.
      if (isMissingUpdateFeedError(error)) continue;
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      throw new Error(`Unable to check for updates${detail}. Check your network connection and try again.`, { cause: error });
    }

    const updateInfo = updateResult?.updateInfo;
    const nextVersion =
      (typeof updateInfo?.version === 'string' && updateInfo.version) ||
      currentVersion;
    const available = compareVersions(nextVersion, currentVersion) > 0;
    if (available) {
      return {
        available: true,
        updateInfo,
        updateResult,
        nextVersion,
        pendingUpdate: { version: nextVersion, electronUpdate: updateResult },
      };
    }
  }

  return {
    available: false,
    updateInfo: null,
    updateResult: null,
    nextVersion: currentVersion,
    pendingUpdate: null,
  };
};
