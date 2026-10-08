import type {
  PiExtensionAppPayload,
  PiExtensionDialogPayload,
  PiExtensionEntryEvent,
  PiExtensionMessageEvent,
  PiExtensionPanelPayload,
} from '../protocol';
import type {
  PiExtensionEditorOp,
  PiReducerExtensionNotice,
  PiReducerMessage,
  PiReducerSessionState,
  PiReducerState,
} from './reducerTypes';
import {
  appendBoundedFeed,
  appendBoundedNoticeFeed,
  markMutation,
  MAX_EXTENSION_NOTICE_ITEMS,
  nextExtensionFeedId,
} from './reducerHelpers';
import type { PiSessionId } from '../types';
import { sanitizeExtensionMessageRender } from '../extension-ui';
import { toClientTimestamp } from '../server-clock';

export const reduceExtensionEntry = (
  session: PiReducerSessionState,
  directory: string,
  sessionId: PiSessionId,
  payload: PiExtensionEntryEvent['payload'],
): void => {
  if (!payload.customType) return;
  const extensionMessage: PiReducerMessage = {
    id: payload.id,
    sessionId,
    directory,
    role: 'extension',
    customType: payload.customType,
    ...(payload.data !== undefined ? { data: payload.data } : {}),
    createdAt: payload.createdAt,
    text: '',
    thinking: '',
    streaming: false,
  };
  session.messages = new Map(session.messages);
  session.messages.set(extensionMessage.id, extensionMessage);
  markMutation(session, extensionMessage.id, 'structure');
};

export const reduceExtensionMessage = (
  session: PiReducerSessionState,
  directory: string,
  sessionId: PiSessionId,
  payload: PiExtensionMessageEvent['payload'],
): void => {
  if (!payload.customType) return;
  const render = sanitizeExtensionMessageRender(payload.render);
  const extensionMessage: PiReducerMessage = {
    id: payload.id,
    sessionId,
    directory,
    role: 'extension',
    customType: payload.customType,
    ...(payload.details !== undefined ? { details: payload.details } : {}),
    ...(render ? { render } : {}),
    createdAt: payload.createdAt,
    text: payload.text ?? '',
    thinking: '',
    streaming: false,
  };
  session.messages = new Map(session.messages);
  session.messages.set(extensionMessage.id, extensionMessage);
  markMutation(session, extensionMessage.id, 'structure');
};

export const reduceExtensionStatus = (
  session: PiReducerSessionState,
  payload: { key: string; text?: string },
): void => {
  session.extensionStatuses = new Map(session.extensionStatuses);
  if (typeof payload.text === 'string' && payload.text.length > 0) {
    session.extensionStatuses.set(payload.key, payload.text);
  } else {
    session.extensionStatuses.delete(payload.key);
  }
};

export const reduceExtensionWidget = (
  session: PiReducerSessionState,
  payload: { key: string; lines?: string[]; placement?: 'aboveEditor' | 'belowEditor' },
): void => {
  session.extensionWidgets = new Map(session.extensionWidgets);
  if (Array.isArray(payload.lines) && payload.lines.length > 0) {
    session.extensionWidgets.set(payload.key, {
      lines: payload.lines,
      placement: payload.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor',
    });
  } else {
    session.extensionWidgets.delete(payload.key);
  }
};

export const reduceExtensionDialog = (
  session: PiReducerSessionState,
  payload: PiExtensionDialogPayload,
): void => {
  if (session.extensionDialogs.some((dialog) => dialog.requestId === payload.requestId)) return;
  session.extensionDialogs = [...session.extensionDialogs, payload];
};

export const reduceExtensionDialogDismiss = (
  session: PiReducerSessionState,
  payload: { requestId: string },
): void => {
  if (!session.extensionDialogs.some((dialog) => dialog.requestId === payload.requestId)) return;
  session.extensionDialogs = session.extensionDialogs.filter(
    (dialog) => dialog.requestId !== payload.requestId,
  );
};

export const reduceExtensionNotify = (
  session: PiReducerSessionState,
  payload: {
    message: string;
    level: 'info' | 'warning' | 'error';
    id?: string;
    createdAt?: number;
    serverNow?: number;
  },
): void => {
  // Prefer the daemon-assigned identity so reconnect replays and snapshot
  // history reconcile against the same id. Older servers send neither field.
  const id = typeof payload.id === 'string' && payload.id.length > 0
    ? payload.id
    : nextExtensionFeedId();
  // A replayed event with a known id is a no-op: leave the list reference
  // untouched so downstream selectors stay stable.
  if (session.extensionNotices.some((notice) => notice.id === id)) return;
  const serverCreatedAt = typeof payload.createdAt === 'number'
    && Number.isFinite(payload.createdAt)
    && payload.createdAt > 0
    ? payload.createdAt
    : undefined;
  const clientNow = Date.now();
  const rawServerNow = payload.serverNow;
  // Record the skew-corrected client-clock receive time so the toast
  // freshness guard measures in one clock domain. Only when the event
  // carries a clock sample; without it keep the legacy behavior.
  const toastAgeBase = serverCreatedAt !== undefined
    && typeof rawServerNow === 'number'
    && Number.isFinite(rawServerNow)
    && rawServerNow > 0
    ? toClientTimestamp(serverCreatedAt, rawServerNow, clientNow) ?? serverCreatedAt
    : undefined;
  session.extensionNotices = appendBoundedNoticeFeed(session.extensionNotices, {
    id,
    message: payload.message,
    level: payload.level,
    createdAt: serverCreatedAt ?? clientNow,
    origin: 'live',
    serverTimestamp: serverCreatedAt !== undefined,
    ...(toastAgeBase !== undefined ? { toastAgeBase } : {}),
  });
};

/** Validate one snapshot/detail notice entry; malformed entries are dropped. */
const toHistoryExtensionNotice = (entry: unknown): PiReducerExtensionNotice | null => {
  if (!entry || typeof entry !== 'object') return null;
  const candidate = entry as { id?: unknown; level?: unknown; message?: unknown; createdAt?: unknown };
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.message !== 'string' || candidate.message.length === 0) return null;
  if (candidate.level !== 'info' && candidate.level !== 'warning' && candidate.level !== 'error') return null;
  if (typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt) || candidate.createdAt <= 0) return null;
  return {
    id: candidate.id,
    message: candidate.message,
    level: candidate.level,
    createdAt: candidate.createdAt,
    origin: 'history',
    serverTimestamp: true,
  };
};

/**
 * Authoritatively replace the notice list with snapshot/detail history
 * (oldest first). Entries whose ids are already held as live keep their
 * live record so a shown notice is neither re-toasted nor duplicated.
 * Returns `null` when `history` is absent or malformed (older server) —
 * the caller must keep the current list in that case.
 */
export const replaceExtensionNoticesWithHistory = (
  current: PiReducerSessionState['extensionNotices'],
  history: unknown,
): PiReducerExtensionNotice[] | null => {
  if (!Array.isArray(history)) return null;
  const liveById = new Map<string, PiReducerExtensionNotice>();
  for (const notice of current) {
    if (notice.origin === 'live' && !liveById.has(notice.id)) liveById.set(notice.id, notice);
  }
  const seen = new Set<string>();
  const next: PiReducerExtensionNotice[] = [];
  for (const raw of history) {
    const notice = toHistoryExtensionNotice(raw);
    if (!notice || seen.has(notice.id)) continue;
    seen.add(notice.id);
    next.push(liveById.get(notice.id) ?? notice);
  }
  return next.length > MAX_EXTENSION_NOTICE_ITEMS
    ? next.slice(next.length - MAX_EXTENSION_NOTICE_ITEMS)
    : next;
};

/**
 * Apply a snapshot's `extensionNotices` field. Absent (or malformed) keeps
 * the current list; present (even empty) replaces it authoritatively.
 */
export const applySnapshotExtensionNotices = (
  session: PiReducerSessionState,
  history: unknown,
): void => {
  const next = replaceExtensionNoticesWithHistory(session.extensionNotices, history);
  if (next === null) return;
  session.extensionNotices = next;
};

export const reduceExtensionCatalog = (
  session: PiReducerSessionState,
  payload: { commands?: boolean },
): void => {
  if (payload.commands === true) {
    session.extensionCatalogRevision = (session.extensionCatalogRevision ?? 0) + 1;
  }
};

export const reduceExtensionEditor = (
  session: PiReducerSessionState,
  payload: { text: string; mode?: 'set' | 'paste' },
  sequence: number,
): void => {
  const mode = payload.mode === 'paste' ? 'paste' : 'set';
  const op: PiExtensionEditorOp = { text: payload.text, mode, sequence };
  if (mode === 'set') {
    session.extensionEditorOps = [op];
  } else {
    const existing = session.extensionEditorOps ?? (session.extensionEditor ? [session.extensionEditor] : []);
    const nextOps = [...existing, op];
    if (nextOps.length > 32) {
      nextOps.splice(0, nextOps.length - 32);
    }
    session.extensionEditorOps = nextOps;
  }
  session.extensionEditor = op;
};

export const reduceExtensionTitle = (
  session: PiReducerSessionState,
  payload: { title?: string },
): void => {
  session.extensionTitle = payload.title;
};

export const reduceExtensionUi = (
  session: PiReducerSessionState,
  panel: PiExtensionPanelPayload,
): void => {
  session.extensionPanels = new Map(session.extensionPanels);
  const hasBody = panel.component !== undefined || panel.title !== undefined || panel.actions !== undefined;
  if (panel.removed === true || !hasBody) {
    session.extensionPanels.delete(panel.id);
  } else {
    session.extensionPanels.set(panel.id, panel);
  }
};

export const reduceExtensionApp = (
  session: PiReducerSessionState,
  app: PiExtensionAppPayload,
): void => {
  session.extensionApps = new Map(session.extensionApps);
  if (app.removed === true || typeof app.html !== 'string' || app.html.length === 0) {
    session.extensionApps.delete(app.appId);
  } else {
    session.extensionApps.set(app.appId, app);
  }
};

export const reduceExtensionError = (
  session: PiReducerSessionState,
  payload: { source: string; event?: string; message: string },
): void => {
  session.extensionErrors = appendBoundedFeed(session.extensionErrors, {
    id: nextExtensionFeedId(),
    source: payload.source,
    ...(payload.event !== undefined ? { event: payload.event } : {}),
    message: payload.message,
    createdAt: Date.now(),
  });
};

export const reduceExtensionWorking = (
  session: PiReducerSessionState,
  payload: { message?: string; visible?: boolean },
): void => {
  const message = payload.message || undefined;
  const visible = payload.visible;
  if (message === undefined && visible === undefined) {
    delete session.extensionWorking;
  } else {
    session.extensionWorking = {
      ...(message !== undefined ? { message } : {}),
      ...(visible !== undefined ? { visible } : {}),
    };
  }
};

/**
 * Remove an extension dialog from a session's pending queue after the client
 * successfully answered it. Returns the original state when the dialog is
 * absent so callers can skip store writes.
 */
export const dismissExtensionDialog = (
  state: PiReducerState,
  sessionId: PiSessionId,
  requestId: string,
): PiReducerState => {
  const session = state.bySession.get(sessionId);
  if (!session) return state;
  const index = session.extensionDialogs.findIndex((dialog) => dialog.requestId === requestId);
  if (index === -1) return state;
  const nextSession: PiReducerSessionState = {
    ...session,
    extensionDialogs: session.extensionDialogs.filter((dialog) => dialog.requestId !== requestId),
  };
  return {
    bySession: new Map(state.bySession).set(sessionId, nextSession),
    lastSequence: new Map(state.lastSequence),
  };
};
