const MISSING_UPDATE_FEED_RE =
  /\b(?:HttpError:\s*404|status code 404|404 Not Found)\b/i;
const CHANGELOG_BASE_URL = 'https://raw.githubusercontent.com/RyderAsKing/PiChamber';
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/RyderAsKing/PiChamber/releases';

export const formatUpdaterReleaseNotes = (releaseNotes, options = {}) => {
  if (typeof releaseNotes === 'string') {
    return releaseNotes.trim() || null;
  }
  if (!Array.isArray(releaseNotes)) return null;

  const { fromVersion, toVersion, compareVersions } = options;
  const sections = releaseNotes.flatMap((releaseNote) => {
    const note = typeof releaseNote?.note === 'string' ? releaseNote.note.trim() : '';
    if (!note) return [];
    const version = typeof releaseNote?.version === 'string' ? releaseNote.version.trim() : '';
    if (
      version
      && typeof compareVersions === 'function'
      && (compareVersions(version, fromVersion) <= 0 || compareVersions(version, toVersion) > 0)
    ) {
      return [];
    }
    if (/^##\s+\[/m.test(note)) return [note];
    return [version ? `## [${version}]\n\n${note}` : note];
  });
  return sections.length > 0 ? sections.join('\n\n') : null;
};

export const fetchRelevantChangelogNotes = async ({
  fromVersion,
  toVersion,
  compareVersions,
  fetchImpl = globalThis.fetch,
}) => {
  const tag = `v${encodeURIComponent(toVersion)}`;
  try {
    const response = await fetchImpl(`${GITHUB_RELEASES_API_URL}/tags/${tag}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pichamber-update-check',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const release = await response.json();
      const body = typeof release?.body === 'string' ? release.body.trim() : '';
      if (body) return body;
    }
  } catch {
  }

  try {
    const response = await fetchImpl(`${CHANGELOG_BASE_URL}/${tag}/CHANGELOG.md`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const changelog = await response.text();
    const sections = changelog.split(/^##\s+\[/m).slice(1);
    const relevant = [];
    for (const section of sections) {
      const version = section.split(']')[0];
      if (compareVersions(version, fromVersion) > 0 && compareVersions(version, toVersion) <= 0) {
        relevant.push(`## [${section}`.trim());
      }
    }
    return relevant.length > 0 ? relevant.join('\n\n') : null;
  } catch {
    return null;
  }
};

export const isMissingUpdateFeedError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return error?.statusCode === 404
    || error?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    || MISSING_UPDATE_FEED_RE.test(message);
};

export const checkForDesktopUpdate = async ({
  autoUpdater,
  currentVersion,
  compareVersions,
  updateChecks = null,
}) => {
  const checks = updateChecks?.length ? updateChecks : [null];
  const configureCheck = (check) => {
    if (!check) return;
    autoUpdater.allowPrerelease = check.allowPrerelease;
    autoUpdater.channel = check.channel;
    // electron-updater enables downgrades whenever channel is assigned.
    autoUpdater.allowDowngrade = false;
  };
  const runCheck = async ({ allowMissingFeed, check }) => {
    try {
      return await autoUpdater.checkForUpdates();
    } catch (error) {
      // A channel has no updates until its first manifest is published.
      const missingRcRelease = check?.channel === 'rc'
        && error?.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS';
      if (allowMissingFeed && (isMissingUpdateFeedError(error) || missingRcRelease)) return null;
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      throw new Error(`Unable to check for updates${detail}. Check your network connection and try again.`, { cause: error });
    }
  };

  let selectedCandidate = null;
  let activeCandidate = null;
  for (const check of checks) {
    configureCheck(check);
    const updateResult = await runCheck({ allowMissingFeed: true, check });
    if (!updateResult) continue;

    const updateInfo = updateResult.updateInfo;
    const nextVersion =
      (typeof updateInfo?.version === 'string' && updateInfo.version) ||
      currentVersion;
    if (updateResult.isUpdateAvailable === false || compareVersions(nextVersion, currentVersion) <= 0) continue;

    const candidate = { check, updateInfo, updateResult, nextVersion };
    activeCandidate = candidate;
    if (!selectedCandidate || compareVersions(nextVersion, selectedCandidate.nextVersion) > 0) {
      selectedCandidate = candidate;
    }
  }

  if (!selectedCandidate) {
    return {
      available: false,
      updateInfo: null,
      updateResult: null,
      nextVersion: currentVersion,
      pendingUpdate: null,
    };
  }

  configureCheck(selectedCandidate.check);
  if (activeCandidate !== selectedCandidate) {
    const updateResult = await runCheck({ allowMissingFeed: false });
    const updateInfo = updateResult?.updateInfo;
    const nextVersion =
      (typeof updateInfo?.version === 'string' && updateInfo.version) ||
      currentVersion;
    if (updateResult?.isUpdateAvailable === false || nextVersion !== selectedCandidate.nextVersion) {
      throw new Error('Available update changed while checking. Try again.');
    }
    selectedCandidate = { ...selectedCandidate, updateInfo, updateResult };
  }

  return {
    available: true,
    updateInfo: selectedCandidate.updateInfo,
    updateResult: selectedCandidate.updateResult,
    nextVersion: selectedCandidate.nextVersion,
    pendingUpdate: {
      version: selectedCandidate.nextVersion,
      electronUpdate: selectedCandidate.updateResult,
    },
  };
};

// electron-updater keeps mutable download metadata, separate from our UI result.
// All checks and downloads must share this coordinator, including across windows.
export const createDesktopUpdateCoordinator = ({ autoUpdater, state, compareVersions }) => {
  let tail = Promise.resolve();
  const exclusive = (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };

  return {
    check: (options) => exclusive(async () => {
      // A failed probe may already have replaced electron-updater's target.
      // Never leave the previous pending record usable after that happens.
      state.pendingUpdate = null;
      const result = await checkForDesktopUpdate({ ...options, autoUpdater, compareVersions });
      state.pendingUpdate = result.pendingUpdate;
      return result;
    }),
    download: () => exclusive(async () => {
      const pending = state.pendingUpdate;
      if (!pending?.electronUpdate) throw new Error('No pending update. Check for updates again.');
      if (pending.downloaded) return;

      let downloadedVersion;
      const onDownloaded = (info) => { downloadedVersion = info?.version; };
      autoUpdater.on('update-downloaded', onDownloaded);
      try {
        await autoUpdater.downloadUpdate();
        if (downloadedVersion !== pending.version) {
          state.pendingUpdate = null;
          throw new Error('Downloaded update does not match the selected version. Check for updates again.');
        }
        pending.downloaded = true;
      } finally {
        autoUpdater.off('update-downloaded', onDownloaded);
      }
    }),
  };
};
