import type {
  PiExtensionAppPayload,
  PiExtensionDialogPayload,
  PiExtensionEntryEvent,
  PiExtensionMessageEvent,
  PiExtensionPanelPayload,
} from '../protocol';
import type {
  PiReducerMessage,
  PiReducerSessionState,
  PiReducerState,
} from './reducerTypes';
import {
  appendBoundedFeed,
  markMutation,
  nextExtensionFeedId,
} from './reducerHelpers';
import type { PiSessionId } from '../types';

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
  const extensionMessage: PiReducerMessage = {
    id: payload.id,
    sessionId,
    directory,
    role: 'extension',
    customType: payload.customType,
    ...(payload.details !== undefined ? { details: payload.details } : {}),
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
  payload: { message: string; level: 'info' | 'warning' | 'error' },
): void => {
  session.extensionNotices = appendBoundedFeed(session.extensionNotices, {
    id: nextExtensionFeedId(),
    message: payload.message,
    level: payload.level,
    createdAt: Date.now(),
  });
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
  payload: { text: string },
  sequence: number,
): void => {
  session.extensionEditor = { text: payload.text, sequence };
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
