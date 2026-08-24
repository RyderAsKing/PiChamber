import { randomUUID } from 'node:crypto';

import {
  MAX_EXTENSION_APP_HTML_CHARS,
  sanitizeExtensionFormFields,
  validateExtensionFormValues,
} from '../extension-protocol.js';

const MAX_EXTENSION_PANELS_PER_SESSION = 24;
const MAX_EXTENSION_APPS_PER_SESSION = 8;
const MAX_EXTENSION_PANEL_ACTIONS = 8;

const textFromContent = (content) => (
  Array.isArray(content)
    ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
    : ''
);

/** Owns extension UI bridge state and translation for one daemon instance. */
export const createExtensionBridge = ({
  publish,
  resolveDirectory,
  redactAttachmentPaths,
  redactAttachmentValues,
  findRuntimeBySessionId,
  getDefaultDirectory,
  getSequence,
  protocolError,
}) => {
  const extensionStatusesBySession = new Map();
  const extensionWidgetsBySession = new Map();
  const extensionPanelsBySession = new Map();
  const extensionAppsBySession = new Map();
  // --- Extension bridging -------------------------------------------------
  // Pi extensions run inside each session runtime. Their user-interaction
  // surface (dialogs, notifications, statuses, widgets) is translated here
  // into public stream events; blocking dialogs are resolved by the
  // `extensions.respond` daemon command.
  const pendingExtensionDialogs = new Map();

  const cancelPendingExtensionDialogs = (sessionId, reason = 'aborted') => {
    for (const pending of pendingExtensionDialogs.values()) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      pending.settle({}, reason);
    }
  };

  const clearExtensionState = (sessionId) => {
    if (sessionId) {
      extensionStatusesBySession.delete(sessionId);
      extensionWidgetsBySession.delete(sessionId);
      extensionPanelsBySession.delete(sessionId);
      extensionAppsBySession.delete(sessionId);
      cancelPendingExtensionDialogs(sessionId, 'session-closed');
    } else {
      extensionStatusesBySession.clear();
      extensionWidgetsBySession.clear();
      extensionPanelsBySession.clear();
      extensionAppsBySession.clear();
      cancelPendingExtensionDialogs(undefined, 'daemon-stopped');
    }
  };

  const createExtensionUIContext = (sessionId) => {
    const dialog = (method, fields, opts, parseResponse) => {
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const settle = (response, reason = 'answered') => {
          if (pendingExtensionDialogs.get(requestId)?.settle !== settle) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          pendingExtensionDialogs.delete(requestId);
          publish('extension.dialog.dismiss', { requestId, reason }, sessionId);
          resolve(parseResponse(response));
        };
        const onAbort = () => settle({}, 'aborted');
        const timer = opts?.timeout
          ? setTimeout(() => settle({}, 'timeout'), opts.timeout)
          : undefined;
        const signal = opts?.signal;
        signal?.addEventListener('abort', onAbort, { once: true });
        const payload = {
          requestId,
          method,
          ...fields,
          ...(Number.isFinite(opts?.timeout) ? { timeoutMs: opts.timeout } : {}),
        };
        pendingExtensionDialogs.set(requestId, { sessionId, settle, timer, payload });
        publish('extension.dialog', payload, sessionId);
      });
    };

    return {
      select: (title, options, opts) => dialog(
        'select',
        { title, options: options.map((option) => String(option)) },
        opts,
        (response) => (typeof response?.value === 'string' ? response.value : undefined),
      ),
      confirm: (title, message, opts) => dialog(
        'confirm',
        { title, message },
        opts,
        (response) => response?.confirmed === true,
      ),
      input: (title, placeholder, opts) => dialog(
        'input',
        { title, ...(typeof placeholder === 'string' ? { placeholder } : {}) },
        opts,
        (response) => (typeof response?.value === 'string' ? response.value : undefined),
      ),
      form: (title, fields, opts) => {
        // PiChamber-specific extension of the pi UI bridge (gate with
        // isPiChamber(ctx)): structured multi-input dialogs resolved with a
        // values object keyed by field id.
        const sanitizedFields = sanitizeExtensionFormFields(fields);
        return dialog(
          'form',
          { title, ...(sanitizedFields.length > 0 ? { fields: sanitizedFields } : {}) },
          opts,
          (response) => (response?.values && typeof response.values === 'object' && !Array.isArray(response.values)
            ? response.values
            : undefined),
        );
      },
      editor: (title, prefill) => dialog(
        'editor',
        { title, ...(typeof prefill === 'string' ? { prefill } : {}) },
        undefined,
        (response) => (typeof response?.value === 'string' ? response.value : undefined),
      ),
      notify: (message, level) => {
        publish('extension.notify', {
          message: String(message ?? ''),
          ...(level === 'warning' || level === 'error' ? { level } : { level: 'info' }),
        }, sessionId);
      },
      setStatus: (key, text) => {
        if (typeof key !== 'string' || key.length === 0) return;
        // Mirror into server-side normalized state for snapshot / reconnect.
        const statuses = extensionStatusesBySession.get(sessionId) ?? new Map();
        if (typeof text === 'string' && text.length > 0) statuses.set(key, String(text).slice(0, 1000));
        else statuses.delete(key);
        if (statuses.size === 0) extensionStatusesBySession.delete(sessionId);
        else extensionStatusesBySession.set(sessionId, statuses);
        publish('extension.status', {
          key,
          ...(typeof text === 'string' && text.length > 0 ? { text: String(text).slice(0, 1000) } : {}),
        }, sessionId);
      },
      setWidget: (key, content, options) => {
        if (typeof key !== 'string' || key.length === 0) return;
        // Only string-array widgets are representable over the wire.
        if (content !== undefined && !Array.isArray(content)) return;
        const widgets = extensionWidgetsBySession.get(sessionId) ?? new Map();
        if (Array.isArray(content) && content.length > 0) {
          const lines = content.map((line) => String(line).slice(0, 2000)).slice(0, 100);
          const placement = options?.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor';
          widgets.set(key, { lines, placement });
        } else {
          widgets.delete(key);
        }
        if (widgets.size === 0) extensionWidgetsBySession.delete(sessionId);
        else extensionWidgetsBySession.set(sessionId, widgets);
        publish('extension.widget', {
          key,
          ...(Array.isArray(content) && content.length > 0 ? { lines: content.map((line) => String(line).slice(0, 2000)).slice(0, 100) } : {}),
          ...(options?.placement === 'belowEditor' ? { placement: 'belowEditor' } : Array.isArray(content) && content.length > 0 ? { placement: 'aboveEditor' } : {}),
        }, sessionId);
      },
      // Terminal-only surfaces have no PiChamber equivalent yet.
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => '',
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Theme switching is not supported in PiChamber sessions.' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      // Extensions may style status/widget strings with theme helpers; those
      // strings are rendered as plain text in PiChamber, so pass them through.
      get theme() {
        return identityTheme;
      },
    };
  };

  const identityTheme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    strikethrough: (text) => text,
  };

  const buildExtensionBindings = (session) => ({
    uiContext: createExtensionUIContext(session.sessionId),
    mode: 'rpc',
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async (options) => {
        const owner = findRuntimeBySessionId(session.sessionId);
        if (!owner) throw new Error('Session runtime is no longer available.');
        return owner.newSession(options);
      },
      fork: async (entryId, forkOptions) => {
        const owner = findRuntimeBySessionId(session.sessionId);
        if (!owner) throw new Error('Session runtime is no longer available.');
        const result = await owner.fork(entryId, forkOptions);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId, navigateOptions) => {
        const result = await session.navigateTree(targetId, {
          summarize: navigateOptions?.summarize,
          customInstructions: navigateOptions?.customInstructions,
          replaceInstructions: navigateOptions?.replaceInstructions,
          label: navigateOptions?.label,
        });
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, switchOptions) => {
        const owner = findRuntimeBySessionId(session.sessionId);
        if (!owner) throw new Error('Session runtime is no longer available.');
        return owner.switchSession(sessionPath, switchOptions);
      },
    },
    onError: (error) => {
      publish('extension.error', {
        source: typeof error?.extensionPath === 'string' ? error.extensionPath : 'unknown',
        ...(typeof error?.event === 'string' ? { event: error.event } : {}),
        message: String(error?.error ?? 'Unknown extension error.'),
      }, session.sessionId);
    },
  });


  // Resolves a pending extension dialog. Unknown or already-settled request
  // ids resolve to `{ resolved: false }` instead of throwing: a stale client
  // retry must never tear down the shared daemon socket.
  const resolveExtensionDialog = async (payload) => {
    if (!payload || typeof payload.requestId !== 'string' || payload.requestId.length === 0) {
      throw protocolError('INVALID_ARGUMENT', 'The extension dialog response is invalid.');
    }
    const pending = pendingExtensionDialogs.get(payload.requestId);
    if (!pending) {
      return { resolved: false };
    }
    if (payload.directory !== undefined) await resolveDirectory(payload.directory);
    if (payload.cancelled === true) {
      // Dialog closures derive their typed result (undefined/false) from an
      // empty response, which mirrors a timeout or explicit cancellation.
      pending.settle({}, 'cancelled');
    } else if (payload.confirmed === true) {
      pending.settle({ confirmed: true });
    } else if (typeof payload.value === 'string') {
      pending.settle({ value: payload.value });
    } else if (payload.values && typeof payload.values === 'object' && !Array.isArray(payload.values)) {
      const values = {};
      for (const [key, entry] of Object.entries(payload.values)) {
        if (typeof key === 'string' && key.length > 0 && key.length <= 128 && typeof entry === 'string' && entry.length <= 8_000) {
          values[key] = entry;
        }
      }
      if (pending.payload?.method !== 'form' || !validateExtensionFormValues(pending.payload.fields, values)) {
        throw protocolError('INVALID_ARGUMENT', 'The extension form response is invalid.');
      }
      pending.settle({ values });
    } else {
      pending.settle({});
    }
    return { resolved: true };
  };

  const publishExtensionCustomMessage = (sessionId, message, directory = getDefaultDirectory()) => {
    if (typeof message.customType !== 'string' || message.customType.length === 0) return;
    // Context-only custom messages (display: false) are not user-visible content.
    if (message.display === false) return;
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? textFromContent(message.content)
        : '';
    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
    publish('extension.message', {
      id: `custom-${sessionId}-${getSequence() + 1}`,
      customType: message.customType,
      text: redactAttachmentPaths(text),
      ...(message.details !== undefined ? { details: redactAttachmentValues(message.details) } : {}),
      createdAt: timestamp,
    }, sessionId, directory);
  };

  // Mirrors a declarative `pichamber.ui` descriptor into normalized panel
  // state and publishes an `extension.ui` event. Latest wins per stable id;
  // `removed: true` (or a payload without component/title) unregisters.
  const mirrorExtensionPanel = (sessionId, descriptor, directory) => {
    const id = typeof descriptor.id === 'string' && descriptor.id.length > 0 ? descriptor.id.slice(0, 128) : '';
    if (!id) return;
    const hasBody = typeof descriptor.component === 'string'
      || typeof descriptor.title === 'string'
      || Array.isArray(descriptor.actions);
    const removed = descriptor.removed === true || !hasBody;
    const panels = extensionPanelsBySession.get(sessionId) ?? new Map();
    const normalized = removed ? undefined : {
      id,
      ...(typeof descriptor.title === 'string' ? { title: descriptor.title.slice(0, 256) } : {}),
      ...(typeof descriptor.component === 'string' ? { component: descriptor.component.slice(0, 64) } : {}),
      ...(descriptor.props && typeof descriptor.props === 'object' && !Array.isArray(descriptor.props) ? { props: redactAttachmentValues(descriptor.props) } : {}),
      ...(Array.isArray(descriptor.actions) ? { actions: descriptor.actions.slice(0, MAX_EXTENSION_PANEL_ACTIONS) } : {}),
    };
    if (removed) {
      panels.delete(id);
    } else {
      panels.set(id, normalized);
    }
    if (panels.size > MAX_EXTENSION_PANELS_PER_SESSION) {
      const oldest = [...panels.keys()].slice(0, panels.size - MAX_EXTENSION_PANELS_PER_SESSION);
      for (const key of oldest) panels.delete(key);
    }
    if (panels.size === 0) extensionPanelsBySession.delete(sessionId);
    else extensionPanelsBySession.set(sessionId, panels);
    publish('extension.ui', removed ? { id, removed: true } : normalized, sessionId, directory);
  };

  // Mirrors a `pichamber.app` descriptor into normalized app state and
  // publishes an `extension.app` event. HTML is capped; removal unregisters.
  const mirrorExtensionApp = (sessionId, descriptor, directory) => {
    const appId = typeof descriptor.appId === 'string' && descriptor.appId.length > 0 ? descriptor.appId.slice(0, 128) : '';
    if (!appId) return;
    const html = typeof descriptor.html === 'string'
      ? (descriptor.html.length > MAX_EXTENSION_APP_HTML_CHARS ? descriptor.html.slice(0, MAX_EXTENSION_APP_HTML_CHARS) : descriptor.html)
      : undefined;
    const removed = descriptor.removed === true || !html || html.length === 0;
    const apps = extensionAppsBySession.get(sessionId) ?? new Map();
    if (removed) {
      apps.delete(appId);
    } else {
      apps.set(appId, {
        appId,
        ...(typeof descriptor.title === 'string' ? { title: descriptor.title.slice(0, 256) } : {}),
        html,
      });
    }
    if (apps.size > MAX_EXTENSION_APPS_PER_SESSION) {
      const oldest = [...apps.keys()].slice(0, apps.size - MAX_EXTENSION_APPS_PER_SESSION);
      for (const key of oldest) apps.delete(key);
    }
    if (apps.size === 0) extensionAppsBySession.delete(sessionId);
    else extensionAppsBySession.set(sessionId, apps);
    publish('extension.app', {
      appId,
      ...(removed ? { removed: true } : {
        ...(typeof descriptor.title === 'string' ? { title: descriptor.title.slice(0, 256) } : {}),
        html,
      }),
    }, sessionId, directory);
  };

  const getSnapshotState = (sessionId) => {
    if (!sessionId) return {};
    const statuses = extensionStatusesBySession.get(sessionId);
    const widgets = extensionWidgetsBySession.get(sessionId);
    const panels = extensionPanelsBySession.get(sessionId);
    const apps = extensionAppsBySession.get(sessionId);
    const dialogs = [...pendingExtensionDialogs.values()]
      .filter((pending) => pending.sessionId === sessionId)
      .map((pending) => pending.payload);
    return {
      ...(statuses?.size ? { statuses: [...statuses.entries()].map(([key, text]) => ({ key, text })) } : {}),
      ...(widgets?.size ? { widgets: [...widgets.entries()].map(([key, widget]) => ({ key, ...widget })) } : {}),
      ...(dialogs.length ? { dialogs } : {}),
      ...(panels?.size ? { panels: [...panels.values()] } : {}),
      ...(apps?.size ? { apps: [...apps.values()] } : {}),
    };
  };

  return {
    buildExtensionBindings,
    clearExtensionState,
    getSnapshotState,
    mirrorExtensionApp,
    mirrorExtensionPanel,
    publishExtensionCustomMessage,
    resolveExtensionDialog,
  };
};
