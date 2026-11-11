// The Android and iOS app is versioned apart from the server it connects to,
// so it keeps its own update channel on the device. The server's update check
// compares the app against the channel the app sends.

export type UpdateChannel = 'stable' | 'rc';

const STORAGE_KEY = 'pichamber.mobileUpdateChannel';
const RELEASE_CANDIDATE_VERSION = /^\d+\.\d+\.\d+-rc\.[1-9]\d*$/;

export const parseUpdateChannel = (value: unknown): UpdateChannel => (value === 'rc' ? 'rc' : 'stable');

/** An install that is itself a release candidate follows release candidates until the user picks a channel. */
export const defaultMobileUpdateChannel = (appVersion: string | undefined): UpdateChannel => (
  RELEASE_CANDIDATE_VERSION.test(appVersion ?? '') ? 'rc' : 'stable'
);

export const getMobileUpdateChannel = (appVersion: string | undefined): UpdateChannel => {
  try {
    const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'rc' || stored === 'stable') return stored;
  } catch {
    // Storage can be unavailable; fall back to the version-based default.
  }
  return defaultMobileUpdateChannel(appVersion);
};

/** Stores the picked channel; throws when the device refuses to store it so the caller can roll back. */
export const setMobileUpdateChannel = (channel: UpdateChannel): UpdateChannel => {
  window.localStorage.setItem(STORAGE_KEY, channel);
  return channel;
};
