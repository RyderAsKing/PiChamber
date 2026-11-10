/**
 * Auto-archive and auto-delete settings: whole days from 1 to 365, or 0 for
 * off. Off is 0 rather than null so the value survives settings stores that
 * drop nulls. The server picks the starting values once (7/0 on a new
 * install, mapped from the old retention fields otherwise); until settings
 * load, the client treats both as off.
 */
const MAX_SESSION_RETENTION_DAYS = 365;

export const isSessionRetentionDaysSetting = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= 0
  && value <= MAX_SESSION_RETENTION_DAYS;

/** "1 session" or "N sessions", for archive and delete messages. */
export const formatSessionCount = (count: number): string => (count === 1 ? '1 session' : `${count} sessions`);
