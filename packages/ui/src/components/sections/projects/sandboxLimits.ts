import type { PiSandboxDefaults, PiSandboxDefaultsUpdate, PiSandboxLauncherStatus } from '@/lib/pi/protocol';

/** Whether the owner accepted every limit this launcher reports. The saved
 *  default is the server's newest answer; the launcher's flag covers a
 *  default that did not load. */
export const sandboxLimitsAccepted = (launcher: PiSandboxLauncherStatus, defaults: PiSandboxDefaults | null): boolean => {
  const limits = launcher.limits ?? [];
  if (defaults?.acceptedLimits) return limits.every((limit) => defaults.acceptedLimits?.includes(limit));
  return launcher.limitsAccepted === true;
};

/** The default update that accepts or withdraws `limits`. It never carries
 *  a mode: the mode shown for an unreadable stored default is a placeholder,
 *  and saving it would turn the default off unasked. */
export const sandboxLimitsUpdate = (limits: string[], accept: boolean): PiSandboxDefaultsUpdate => ({
  acceptedLimits: accept ? [...limits] : [],
});
