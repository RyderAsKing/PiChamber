// Open requests: a URL something on the server machine asked PiChamber to
// show (see the `openUrl.publish` command). The daemon owns attribution
// because it owns sessions and their busy state; the PiChamber server owns
// intake and device delivery (lib/open-url).

export const OPEN_REQUEST_MAX_URL_LENGTH = 4096;

/** Returns the normalized http(s) URL, or null when the value is not one. */
export const normalizeOpenRequestUrl = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > OPEN_REQUEST_MAX_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const normalized = parsed.toString();
  return normalized.length > OPEN_REQUEST_MAX_URL_LENGTH ? null : normalized;
};

/**
 * Decide which session an Open request belongs to.
 *
 * 1. `requestedSessionId`: the caller said which session (a bash command
 *    carries Pi's `PI_SESSION_ID`). Exact; used only when that session is
 *    resident in this daemon.
 * 2. Otherwise, when exactly one resident session is busy, the request came
 *    from it: an in-process extension opening a page runs inside a turn,
 *    tool call, or slash command. This is the one deliberate fallback.
 * 3. Otherwise nobody can tell. The request still needs a session to travel
 *    on the event stream, so it rides on the most recently active session
 *    with `attributed: false`.
 *
 * `residents` are `{ sessionId, directory, busy }` rows. Returns
 * `{ sessionId, directory, attributed }` or null when no session exists.
 */
export const resolveOpenRequestSession = ({ requestedSessionId, residents, recent }) => {
  const rows = Array.isArray(residents) ? residents.filter((row) => (
    row && typeof row.sessionId === 'string' && row.sessionId.length > 0
      && typeof row.directory === 'string' && row.directory.length > 0
  )) : [];

  if (typeof requestedSessionId === 'string' && requestedSessionId.length > 0) {
    const match = rows.find((row) => row.sessionId === requestedSessionId);
    if (match) return { sessionId: match.sessionId, directory: match.directory, attributed: true };
  }

  const busy = rows.filter((row) => row.busy === true);
  if (busy.length === 1) {
    return { sessionId: busy[0].sessionId, directory: busy[0].directory, attributed: true };
  }

  const carrier = (recent && rows.find((row) => row.sessionId === recent.sessionId))
    ?? rows[0];
  if (carrier) return { sessionId: carrier.sessionId, directory: carrier.directory, attributed: false };
  return null;
};
