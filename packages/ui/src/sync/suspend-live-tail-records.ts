import type { PiReducerSessionState } from '@/lib/pi/event-reducer';

/**
 * Live assistant currently in `streamingMessages`. Stable across token
 * deltas; null once the turn settles. Chat freeze and the live-tail overlay
 * both key off this id.
 */
export const selectStreamingAssistantMessageId = (
  session: PiReducerSessionState | null | undefined,
): string | null => {
  if (!session || session.streamingMessages.size === 0) return null;
  let streamingId: string | null = null;
  for (const messageId of session.streamingMessages) {
    const message = session.messages.get(messageId);
    if (message?.role === 'assistant') {
      // A second tab can hydrate the persisted Pi entry id, then resume SSE
      // frames that address the same assistant through a synthetic live id.
      // The Map contains both keys, but rendered records keep `message.id`.
      // Return that canonical id so the live-parts overlay can match them.
      streamingId = message.id;
    }
  }
  return streamingId;
};

/**
 * True when every input of the transcript projection is reference-equal.
 * Live side state (shell output, extension status, sequence cursors) replaces
 * the session object without touching the transcript; consumers that only
 * project messages must not re-walk the session for those updates.
 */
export const hasSameTranscriptInputs = (
  previous: PiReducerSessionState,
  next: PiReducerSessionState,
): boolean => previous.sessionId === next.sessionId
  && previous.directory === next.directory
  && previous.messages === next.messages
  && previous.parts === next.parts
  && previous.partOrder === next.partOrder
  && previous.streamingMessages === next.streamingMessages
  && previous.lifecycle === next.lifecycle
  && previous.model === next.model
  && previous.thinking === next.thinking
  && previous.queue === next.queue;

/** Latest user message id in insertion order, or null when there is none. */
const latestUserMessageId = (
  session: PiReducerSessionState,
): string | null => {
  let latest: string | null = null;
  for (const message of session.messages.values()) {
    if (message.role === 'user') latest = message.id;
  }
  return latest;
};

/**
 * True while a plain prompt send is still waiting for the server to echo
 * its user message. The marker self-resolves: the moment the echoed user
 * message is inserted, the latest user id moves past the baseline and this
 * returns false with no explicit clear needed.
 */
export const selectAwaitingPromptEcho = (
  session: PiReducerSessionState | null | undefined,
): boolean => {
  const baseline = session?.awaitingPromptEcho?.baselineUserMessageId;
  if (!session || session.awaitingPromptEcho === undefined) return false;
  return latestUserMessageId(session) === baseline;
};

/**
 * True when `next` only changed a non-user message's parts. Composer arrow
 * history must not walk 200 user turns on every assistant token.
 */
export const shouldReuseUserHistory = (
  previous: PiReducerSessionState,
  next: PiReducerSessionState,
): boolean => {
  if (previous === next) return true;
  if (
    previous.messages === next.messages
    && previous.parts === next.parts
    && previous.partOrder === next.partOrder
  ) return true;
  if (previous.messages.size !== next.messages.size) return false;
  if (next.lastMutationKind === 'structure') return false;
  if (next.lastMutationKind === 'part' && next.lastMutatedMessageId) {
    return next.messages.get(next.lastMutatedMessageId)?.role !== 'user';
  }
  const streamingId = selectStreamingAssistantMessageId(next);
  if (streamingId) {
    return shouldReuseSuspendedRecords(previous, next, streamingId);
  }
  return false;
};

/**
 * True when `next` only changed the suspended message's live parts.
 *
 * `useSessionMessageRecords` freezes transcript records while a message
 * streams; the live tail overlays parts from `useSessionParts`. Rebuilding
 * every token delta walks and re-projects the whole session (100–200 turns)
 * on the main thread.
 *
 * Prefer the reducer's `lastMutatedMessageId` / `lastMutationKind` so a
 * token does not scan every historical part. Fall back to a reference walk
 * when those fields are missing (tests, older snapshots).
 *
 * New messages, historical part edits, and part-order changes on
 * non-suspended messages bust the freeze. New parts on the suspended
 * message itself do not: the tail overlay already mounts them.
 */
export const shouldReuseSuspendedRecords = (
  previous: PiReducerSessionState,
  next: PiReducerSessionState,
  suspendMessageId: string,
): boolean => {
  if (previous === next) return true;
  if (previous.messages.size !== next.messages.size) return false;
  if (previous.messages !== next.messages) return false;

  if (next.lastMutationKind === 'structure') return false;
  if (
    next.lastMutationKind === 'part'
    && next.lastMutatedMessageId === suspendMessageId
  ) {
    return true;
  }
  if (
    next.lastMutationKind === 'part'
    && next.lastMutatedMessageId
    && next.lastMutatedMessageId !== suspendMessageId
  ) {
    return false;
  }

  return historicalPartsUnchanged(previous, next, suspendMessageId);
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const historicalPartsUnchanged = (
  previous: PiReducerSessionState,
  next: PiReducerSessionState,
  suspendMessageId: string,
): boolean => {
  for (const [messageId, message] of next.messages) {
    const previousMessage = previous.messages.get(messageId);
    if (!previousMessage || previousMessage.id !== message.id) return false;
    if (messageId === suspendMessageId) continue;
    if (previousMessage !== message) return false;

    const previousOrder = previous.partOrder.get(messageId) ?? [];
    const nextOrder = next.partOrder.get(messageId) ?? [];
    if (!sameIds(previousOrder, nextOrder)) return false;
    for (const partId of nextOrder) {
      if (previous.parts.get(partId) !== next.parts.get(partId)) return false;
    }
  }

  for (const messageId of previous.messages.keys()) {
    if (!next.messages.has(messageId)) return false;
  }

  return true;
};
