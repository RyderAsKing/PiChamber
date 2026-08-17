import type { PiReducerSessionState } from '@/lib/pi/event-reducer';

const sameIds = (left: readonly string[], right: readonly string[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

/**
 * True when `next` only changed the suspended message's live parts.
 *
 * ChatContainer already asks `useSessionMessageRecords` to freeze transcript
 * records while a message streams; the live tail overlays parts from
 * `useSessionParts`. Rebuilding every token delta walks and re-projects the
 * whole session (100–200 turns) on the main thread. Historical message and
 * part object identities stay stable across text/thinking deltas, so a
 * reference walk is enough to keep the published records array unchanged.
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
