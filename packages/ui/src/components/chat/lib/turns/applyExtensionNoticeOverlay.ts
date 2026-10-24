import type { PiExtensionNotice } from '@/lib/pi/reducers/reducerTypes';

import type { ChatMessageEntry } from './types';

/**
 * Render-time overlay that projects live extension notices (`ctx.ui.notify`)
 * as transcript rows.
 *
 * Notices are live-only local state, never part of `session.messages`, so
 * they cannot ride the projection like `extension.message` items do. This
 * pure function merges them into display order instead:
 *
 * - Each notice becomes an `extension`-role entry with the reserved
 *   `pichamber.notice` custom type, so `MessageRow` routes it to
 *   `ExtensionNoticeRow` before the generic extension handling.
 *   `projectTurnRecords` attaches mid-turn notices to their running turn
 *   (rendered inside `TurnItem` before the reply); notices outside a
 *   running turn stay ungrouped via `buildStaticRenderEntries` /
 *   `UngroupedMessageRow`.
 * - Placement follows daemon-clock `createdAt`: a notice inserts after the
 *   last message whose created time is at most the notice time. Notices
 *   newer than everything append at the end.
 * - Every notice renders; no coalescing or dropping.
 *
 * Performance: the feed is bounded (≤50). With no notices the input array
 * is returned by reference; otherwise one linear pass builds the merged
 * list without cloning the messages it keeps.
 */

/** Reserved custom type marking an overlay-projected notice row. */
export const EXTENSION_NOTICE_CUSTOM_TYPE = 'pichamber.notice' as const;

const messageCreatedAt = (message: ChatMessageEntry): number | undefined => {
  const created = (message.info as { time?: { created?: unknown } }).time?.created;
  return typeof created === 'number' ? created : undefined;
};

// Notice objects are immutable in the reducer feed, so caching the projected
// entry per notice keeps row references stable across the many re-runs of the
// overlay (every streaming update), letting memoized rows skip re-rendering.
const noticeEntryCache = new WeakMap<PiExtensionNotice, { sessionId: string; entry: ChatMessageEntry }>();

const toNoticeEntry = (notice: PiExtensionNotice, sessionId: string): ChatMessageEntry => {
  const cached = noticeEntryCache.get(notice);
  if (cached && cached.sessionId === sessionId) return cached.entry;
  const entry = buildNoticeEntry(notice, sessionId);
  noticeEntryCache.set(notice, { sessionId, entry });
  return entry;
};

const buildNoticeEntry = (notice: PiExtensionNotice, sessionId: string): ChatMessageEntry => ({
  info: {
    id: `notice:${notice.id}`,
    sessionID: sessionId,
    role: 'extension',
    customType: EXTENSION_NOTICE_CUSTOM_TYPE,
    text: notice.message,
    noticeLevel: notice.level,
    time: { created: notice.createdAt, completed: notice.createdAt },
  },
  parts: [],
});

export const applyExtensionNoticeOverlay = (
  messages: ChatMessageEntry[],
  notices: readonly PiExtensionNotice[],
  sessionId: string | null,
): ChatMessageEntry[] => {
  if (!sessionId || notices.length === 0) {
    return messages;
  }

  // Arrival order is the reducer feed order; a stable sort by daemon clock
  // keeps same-timestamp notices in the order they arrived.
  const ordered = [...notices].sort((left, right) => left.createdAt - right.createdAt);

  const merged: ChatMessageEntry[] = [];
  let noticeIndex = 0;
  for (const message of messages) {
    const created = messageCreatedAt(message);
    while (
      noticeIndex < ordered.length
      && (created === undefined || ordered[noticeIndex]!.createdAt <= created)
    ) {
      merged.push(toNoticeEntry(ordered[noticeIndex]!, sessionId));
      noticeIndex += 1;
    }
    merged.push(message);
  }
  while (noticeIndex < ordered.length) {
    merged.push(toNoticeEntry(ordered[noticeIndex]!, sessionId));
    noticeIndex += 1;
  }

  return merged;
};
