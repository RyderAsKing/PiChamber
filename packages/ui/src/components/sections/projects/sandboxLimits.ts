import type { PiSandboxDefaults, PiSandboxDefaultsUpdate, PiSandboxLauncherStatus } from '@/lib/pi/protocol';

/** Whether the owner accepted every limit this launcher reports. The saved
 *  default is the server's newest answer; the launcher's flag covers a
 *  default that did not load. */
export const sandboxLimitsAccepted = (launcher: PiSandboxLauncherStatus, defaults: PiSandboxDefaults | null): boolean => {
  const limits = launcher.limits ?? [];
  if (defaults?.acceptedLimits) return limits.every((limit) => defaults.acceptedLimits?.includes(limit));
  return launcher.limitsAccepted === true;
};

/** The default update that accepts or withdraws `limits`. An unreadable
 *  stored default is saved whole, so the save also repairs it. */
export const sandboxLimitsUpdate = (defaults: PiSandboxDefaults, limits: string[], accept: boolean): PiSandboxDefaultsUpdate => {
  const acceptedLimits = accept ? [...limits] : [];
  return defaults.invalid
    ? { mode: defaults.mode, allowHosts: defaults.allowHosts, acceptedLimits }
    : { acceptedLimits };
};
