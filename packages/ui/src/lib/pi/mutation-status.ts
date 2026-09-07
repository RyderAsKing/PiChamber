interface PiMutationStatus {
  deferred?: boolean;
}

/** True for the stable error code and older servers that only expose it in text. */
export const isSessionBusyError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === 'SESSION_BUSY'
    || (typeof candidate.message === 'string' && candidate.message.includes('SESSION_BUSY'));
};

export const isDeferredPiMutation = (value: unknown): value is PiMutationStatus & { deferred: true } => (
  Boolean(value && typeof value === 'object' && (value as PiMutationStatus).deferred === true)
);

export const deferredSettingsMessage = (subject: string): string => (
  `${subject} saved. It will apply when active sessions are idle.`
);

export const busySettingsMessage = (subject: string): string => (
  `${subject} could not be changed while a session is running. Try again when it finishes.`
);
