/**
 * Translate a server epoch timestamp into this client's epoch using the
 * server's observation time. The offset keeps live timers consistent across
 * devices whose local clocks are not identical.
 *
 * When the server did not provide an observation time, preserve the raw value
 * for compatibility with older runtimes.
 */
export const toClientTimestamp = (
  serverTimestamp: number | undefined,
  serverNow: number | undefined,
  clientNow: number = Date.now(),
): number | undefined => {
  if (typeof serverTimestamp !== 'number' || !Number.isFinite(serverTimestamp)) return undefined;
  if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return serverTimestamp;
  return serverTimestamp - (serverNow - clientNow);
};
