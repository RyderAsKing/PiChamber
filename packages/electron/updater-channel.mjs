const RELEASE_CANDIDATE_VERSION = /^\d+\.\d+\.\d+-rc\.[1-9]\d*$/;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const isReleaseCandidateVersion = (version) => RELEASE_CANDIDATE_VERSION.test(String(version || ''));

export const resolveDesktopUpdateChannel = (value) => value === 'rc' ? 'rc' : 'stable';

export const resolveUpdaterChannel = ({ platform, architecture, releaseChannel = 'stable' }) => {
  if (releaseChannel === 'rc') return 'rc';
  return platform === 'win32' && architecture === 'arm64' ? 'latest-arm64' : 'latest';
};

export const resolveUpdaterChecks = ({ updateChannel = 'stable', platform, architecture }) => {
  const stable = {
    channel: resolveUpdaterChannel({ platform, architecture, releaseChannel: 'stable' }),
    allowPrerelease: false,
  };
  if (resolveDesktopUpdateChannel(updateChannel) !== 'rc') return [stable];
  return [
    stable,
    {
      channel: resolveUpdaterChannel({ platform, architecture, releaseChannel: 'rc' }),
      allowPrerelease: true,
    },
  ];
};

const parseSemver = (version) => {
  const match = SEMVER.exec(String(version || ''));
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') || null,
  };
};

const comparePrerelease = (left, right) => {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return difference;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else {
      const difference = left[index].localeCompare(right[index]);
      if (difference !== 0) return difference;
    }
  }
  return 0;
};

export const compareReleaseVersions = (left, right) => {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true });
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const difference = parsedLeft.core[index] - parsedRight.core[index];
    if (difference !== 0) return difference;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
};
