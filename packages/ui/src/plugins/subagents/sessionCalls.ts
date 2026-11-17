import type { PiReducerSessionState } from '@/lib/pi/reducers/reducerTypes';

/** The tool a sub-agent extension registers (the bundled plugin, or Pi's example). */
export const SUBAGENT_TOOL = 'subagent';

// The reducer replaces `toolsByCallId` whenever a tool call is added or the
// session is hydrated, and leaves it alone for text and tool updates. Keying
// on it means the parts are scanned once per new tool call, not per token.
const answers = new WeakMap<PiReducerSessionState['toolsByCallId'], boolean>();

/** Whether the session's loaded messages hold a sub-agent call. */
export const sessionHasSubagentCall = (session: PiReducerSessionState | undefined): boolean => {
  if (!session) return false;
  const known = answers.get(session.toolsByCallId);
  if (known !== undefined) return known;
  let found = false;
  for (const part of session.parts.values()) {
    if (part.type === 'tool' && part.tool?.name === SUBAGENT_TOOL) {
      found = true;
      break;
    }
  }
  answers.set(session.toolsByCallId, found);
  return found;
};
