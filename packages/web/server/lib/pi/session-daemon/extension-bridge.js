import { randomUUID } from 'node:crypto';

import {
  MAX_EXTENSION_APP_HTML_CHARS,
  sanitizeExtensionFormFields,
  validateExtensionFormValues,
} from '../extension-protocol.js';
import { resolveExtensionName } from './extension-name.js';
import { createExtensionTheme } from './extension-theme.js';

const MAX_EXTENSION_PANELS_PER_SESSION = 24;
const MAX_EXTENSION_APPS_PER_SESSION = 8;
const MAX_EXTENSION_PANEL_ACTIONS = 8;
const MAX_EXTENSION_EDITOR_TEXT_CHARS = 100_000;
const MAX_EXTENSION_TITLE_CHARS = 256;
const MAX_EXTENSION_WORKING_CHARS = 200;
const DEFAULT_COMPONENT_WIDGET_WIDTH = 100;
const COMPONENT_RENDER_THROTTLE_MS = 100;
const PROVIDER_OBSERVER = Symbol('pichamber.extension-provider-observer');
const LABEL_OBSERVER = Symbol('pichamber.extension-label-observer');

const textFromContent = (content) => (
  Array.isArray(content)
    ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
    : ''
);

// Pi keeps `appendEntry` custom entries out of the TUI transcript; they
// persist extension state. Only PiChamber GUI entries are meant to render.
export const isDisplayedExtensionEntryType = (customType) => (
  typeof customType === 'string' && customType.startsWith('pichamber.')
);

export const extractExtensionDescriptor = (entry) => {
  if (!entry || typeof entry !== 'object' || entry.type !== 'custom') return undefined;
  if (!isDisplayedExtensionEntryType(entry.customType)) return undefined;
  const data = entry.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return data.ui && typeof data.ui === 'object' && !Array.isArray(data.ui) ? data.ui : data;
};

export const isIddExtensionEntry = (entry) => {
  const descriptor = extractExtensionDescriptor(entry);
  if (!descriptor) return false;
  if (entry.customType === 'pichamber.app') {
    const appId = typeof descriptor.appId === 'string' && descriptor.appId.length > 0
      ? descriptor.appId
      : (typeof descriptor.id === 'string' && descriptor.id.length > 0 ? descriptor.id : undefined);
    return Boolean(appId);
  }
  return typeof descriptor.id === 'string' && descriptor.id.length > 0;
};

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
  renderExtensionMessage,
  requestSessionShutdown,
  pendingInput,
}) => {
  const extensionStatusesBySession = new Map();
  const extensionWidgetsBySession = new Map();
  const extensionComponentWidgetsBySession = new Map();
  const extensionWidgetRenderTimersBySession = new Map();
  const extensionPanelsBySession = new Map();
  const extensionAppsBySession = new Map();
  const extensionTitlesBySession = new Map();
  const extensionWorkingBySession = new Map();
  const extensionDraftBySession = new Map();
  const extensionDraftTrackedSessions = new Set();
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

  const directoryForSession = (sessionId) => findRuntimeBySessionId(sessionId)?.cwd || getDefaultDirectory();
  const publishForSession = (event, payload, sessionId) => publish(event, payload, sessionId, directoryForSession(sessionId));

  const disposeComponentWidget = (sessionId, key) => {
    const sessionComponents = extensionComponentWidgetsBySession.get(sessionId);
    if (!sessionComponents) return;
    const entry = sessionComponents.get(key);
    if (!entry) return;
    sessionComponents.delete(key);
    if (sessionComponents.size === 0) {
      extensionComponentWidgetsBySession.delete(sessionId);
      const timer = extensionWidgetRenderTimersBySession.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        extensionWidgetRenderTimersBySession.delete(sessionId);
      }
    }
    try {
      entry.component?.dispose?.();
    } catch {
      // Harmless component disposal error
    }
  };

  const renderAndPublishComponentWidget = (sessionId, key) => {
    const sessionComponents = extensionComponentWidgetsBySession.get(sessionId);
    const entry = sessionComponents?.get(key);
    if (!entry) return;

    try {
      const rawLines = entry.component.render(DEFAULT_COMPONENT_WIDGET_WIDTH);
      const lines = Array.isArray(rawLines)
        ? rawLines.map((line) => String(line).slice(0, 2000)).slice(0, 100)
        : [];

      const prevLines = entry.lastRenderedLines;
      const unchanged = prevLines && prevLines.length === lines.length && prevLines.every((l, i) => l === lines[i]);
      if (unchanged) return;

      entry.lastRenderedLines = lines;

      const widgets = extensionWidgetsBySession.get(sessionId) ?? new Map();
      if (lines.length > 0) {
        widgets.set(key, { lines, placement: entry.placement });
      } else {
        widgets.delete(key);
      }
      if (widgets.size === 0) extensionWidgetsBySession.delete(sessionId);
      else extensionWidgetsBySession.set(sessionId, widgets);

      publishForSession('extension.widget', {
        key,
        ...(lines.length > 0 ? { lines, placement: entry.placement } : {}),
      }, sessionId);
    } catch (error) {
      publishForSession('extension.error', {
        source: 'extension.widget',
        event: 'render',
        message: String(error?.message ?? error ?? 'Extension widget render error.'),
      }, sessionId);
      disposeComponentWidget(sessionId, key);
      const widgets = extensionWidgetsBySession.get(sessionId);
      if (widgets) {
        widgets.delete(key);
        if (widgets.size === 0) extensionWidgetsBySession.delete(sessionId);
      }
      publishForSession('extension.widget', { key }, sessionId);
    }
  };

  const scheduleComponentWidgetsRender = (sessionId) => {
    if (!extensionComponentWidgetsBySession.has(sessionId)) return;
    if (extensionWidgetRenderTimersBySession.has(sessionId)) return;
    const timer = setTimeout(() => {
      extensionWidgetRenderTimersBySession.delete(sessionId);
      const sessionComponents = extensionComponentWidgetsBySession.get(sessionId);
      if (!sessionComponents) return;
      for (const key of sessionComponents.keys()) {
        renderAndPublishComponentWidget(sessionId, key);
      }
    }, COMPONENT_RENDER_THROTTLE_MS);
    extensionWidgetRenderTimersBySession.set(sessionId, timer);
  };

  const createTuiStub = (sessionId) => ({
    terminal: {
      columns: DEFAULT_COMPONENT_WIDGET_WIDTH,
      rows: 30,
    },
    requestRender: () => {
      scheduleComponentWidgetsRender(sessionId);
    },
    renderNow: () => {
      const sessionComponents = extensionComponentWidgetsBySession.get(sessionId);
      if (!sessionComponents) return;
      for (const key of sessionComponents.keys()) {
        renderAndPublishComponentWidget(sessionId, key);
      }
    },
    // Harmless minimal TUI no-ops that component implementations may query or call
    mode: 'regular',
    fullRedraws: 0,
    addChild: () => {},
    removeChild: () => {},
    clear: () => {},
    invalidate: () => {},
    getShowHardwareCursor: () => false,
    setShowHardwareCursor: () => {},
    getClearOnShrink: () => false,
    setClearOnShrink: () => {},
    setFocus: () => {},
    getFocusedComponent: () => null,
    showOverlay: () => ({
      hide: () => {},
      setHidden: () => {},
      isHidden: () => false,
      focus: () => {},
      unfocus: () => {},
      isFocused: () => false,
      getBounds: () => undefined,
    }),
    hideOverlay: () => {},
    hasOverlay: () => false,
    start: () => {},
    stop: () => {},
    addInputListener: () => () => {},
    removeInputListener: () => {},
    onTerminalColorSchemeChange: () => () => {},
    setTerminalColorSchemeNotifications: () => {},
    queryTerminalBackgroundColor: async () => undefined,
    queryTerminalColorScheme: async () => undefined,
  });

  const clearOneExtensionState = (sessionId) => {
    const timer = extensionWidgetRenderTimersBySession.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      extensionWidgetRenderTimersBySession.delete(sessionId);
    }
    const sessionComponents = extensionComponentWidgetsBySession.get(sessionId);
    if (sessionComponents) {
      for (const entry of sessionComponents.values()) {
        try {
          entry.component?.dispose?.();
        } catch {
          // ignore
        }
      }
      extensionComponentWidgetsBySession.delete(sessionId);
    }

    const statuses = extensionStatusesBySession.get(sessionId);
    const widgets = extensionWidgetsBySession.get(sessionId);
    const panels = extensionPanelsBySession.get(sessionId);
    const apps = extensionAppsBySession.get(sessionId);
    if (statuses) for (const key of statuses.keys()) publishForSession('extension.status', { key }, sessionId);
    if (widgets) for (const key of widgets.keys()) publishForSession('extension.widget', { key }, sessionId);
    if (panels) for (const id of panels.keys()) publishForSession('extension.ui', { id, removed: true }, sessionId);
    if (apps) for (const appId of apps.keys()) publishForSession('extension.app', { appId, removed: true }, sessionId);
    if (extensionTitlesBySession.has(sessionId)) publishForSession('extension.title', {}, sessionId);
    if (extensionWorkingBySession.has(sessionId)) publishForSession('extension.working', {}, sessionId);
    // Stop browser draft sync; a later getEditorText() call re-enables it.
    if (extensionDraftTrackedSessions.has(sessionId)) publishForSession('extension.editor.track', { enabled: false }, sessionId);
    extensionStatusesBySession.delete(sessionId);
    extensionWidgetsBySession.delete(sessionId);
    extensionPanelsBySession.delete(sessionId);
    extensionAppsBySession.delete(sessionId);
    extensionTitlesBySession.delete(sessionId);
    extensionWorkingBySession.delete(sessionId);
    extensionDraftBySession.delete(sessionId);
    extensionDraftTrackedSessions.delete(sessionId);
    cancelPendingExtensionDialogs(sessionId, 'session-closed');
  };

  const clearExtensionState = (sessionId) => {
    if (sessionId) {
      clearOneExtensionState(sessionId);
      return;
    }
    const sessionIds = new Set([
      ...extensionStatusesBySession.keys(),
      ...extensionWidgetsBySession.keys(),
      ...extensionComponentWidgetsBySession.keys(),
      ...extensionPanelsBySession.keys(),
      ...extensionAppsBySession.keys(),
      ...extensionTitlesBySession.keys(),
      ...extensionWorkingBySession.keys(),
      ...extensionDraftBySession.keys(),
      ...extensionDraftTrackedSessions.keys(),
    ]);
    for (const id of sessionIds) clearOneExtensionState(id);
    cancelPendingExtensionDialogs(undefined, 'daemon-stopped');
  };

  const publishCatalogChange = (sessionId, flags) => {
    publishForSession('extension.catalog', flags, sessionId);
  };

  const installMutationObservers = (session) => {
    const modelRuntime = session?.modelRuntime;
    if (modelRuntime) {
      const observer = modelRuntime[PROVIDER_OBSERVER];
      if (observer) {
        observer.sessionId = session.sessionId;
      } else {
        const state = { sessionId: session.sessionId };
        Object.defineProperty(modelRuntime, PROVIDER_OBSERVER, { value: state });
        for (const method of ['registerProvider', 'registerNativeProvider', 'unregisterProvider']) {
          if (typeof modelRuntime[method] !== 'function') continue;
          const original = modelRuntime[method].bind(modelRuntime);
          modelRuntime[method] = (...args) => {
            const result = original(...args);
            if (!state.suppress) publishCatalogChange(state.sessionId, { providers: true });
            return result;
          };
        }
      }
    }

    const manager = session?.sessionManager;
    if (manager && !manager[LABEL_OBSERVER] && typeof manager.appendLabelChange === 'function') {
      Object.defineProperty(manager, LABEL_OBSERVER, { value: true });
      const original = manager.appendLabelChange.bind(manager);
      manager.appendLabelChange = (...args) => {
        const result = original(...args);
        publishForSession('session.tree.updated', {}, session.sessionId);
        return result;
      };
    }
  };

  const createExtensionUIContext = (sessionId) => {
    const extensionTheme = createExtensionTheme();
    const tuiStub = createTuiStub(sessionId);

    const dialog = (method, fields, opts, parseResponse) => {
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const settle = (response, reason = 'answered') => {
          if (pendingExtensionDialogs.get(requestId)?.settle !== settle) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          pendingExtensionDialogs.delete(requestId);
          publishForSession('extension.dialog.dismiss', { requestId, reason }, sessionId);
          pendingInput?.close(sessionId, requestId);
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
        publishForSession('extension.dialog', payload, sessionId);
        pendingInput?.open({ sessionId, directory: directoryForSession(sessionId), requestId, kind: 'input' });
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
        publishForSession('extension.notify', {
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
        publishForSession('extension.status', {
          key,
          ...(typeof text === 'string' && text.length > 0 ? { text: String(text).slice(0, 1000) } : {}),
        }, sessionId);
      },
      setWidget: (key, content, options) => {
        if (typeof key !== 'string' || key.length === 0) return;
        const placement = options?.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor';

        // Dispose previous component if any
        disposeComponentWidget(sessionId, key);

        if (typeof content === 'function') {
          try {
            const component = content(tuiStub, extensionTheme);
            if (component && typeof component.render === 'function') {
              const sessionComponents = extensionComponentWidgetsBySession.get(sessionId) ?? new Map();
              sessionComponents.set(key, { component, placement, lastRenderedLines: undefined });
              extensionComponentWidgetsBySession.set(sessionId, sessionComponents);
              renderAndPublishComponentWidget(sessionId, key);
            } else {
              const widgets = extensionWidgetsBySession.get(sessionId);
              if (widgets) {
                widgets.delete(key);
                if (widgets.size === 0) extensionWidgetsBySession.delete(sessionId);
              }
              publishForSession('extension.widget', { key }, sessionId);
            }
          } catch (error) {
            publishForSession('extension.error', {
              source: 'extension.widget',
              event: 'factory',
              message: String(error?.message ?? error ?? 'Extension widget factory error.'),
            }, sessionId);
            const widgets = extensionWidgetsBySession.get(sessionId);
            if (widgets) {
              widgets.delete(key);
              if (widgets.size === 0) extensionWidgetsBySession.delete(sessionId);
            }
            publishForSession('extension.widget', { key }, sessionId);
          }
          return;
        }

        if (content !== undefined && content !== null && !Array.isArray(content)) return;

        const widgets = extensionWidgetsBySession.get(sessionId) ?? new Map();
        const hasLines = Array.isArray(content) && content.length > 0;
        if (hasLines) {
          const lines = content.map((line) => String(line).slice(0, 2000)).slice(0, 100);
          widgets.set(key, { lines, placement });
        } else {
          widgets.delete(key);
        }
        if (widgets.size === 0) extensionWidgetsBySession.delete(sessionId);
        else extensionWidgetsBySession.set(sessionId, widgets);
        publishForSession('extension.widget', {
          key,
          ...(hasLines ? {
            lines: content.map((line) => String(line).slice(0, 2000)).slice(0, 100),
            placement,
          } : {}),
        }, sessionId);
      },
      // Terminal-only surfaces have no PiChamber equivalent yet.
      onTerminalInput: () => () => {},
      setWorkingMessage: (message) => {
        const existing = extensionWorkingBySession.get(sessionId) ?? {};
        const sanitized = typeof message === 'string'
          ? message.replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g, '').slice(0, MAX_EXTENSION_WORKING_CHARS)
          : undefined;
        const next = { ...existing };
        if (sanitized !== undefined && sanitized.length > 0) {
          next.message = sanitized;
        } else {
          delete next.message;
        }
        if (next.message === undefined && next.visible === undefined) {
          extensionWorkingBySession.delete(sessionId);
        } else {
          extensionWorkingBySession.set(sessionId, next);
        }
        publishForSession('extension.working', {
          ...(next.message !== undefined ? { message: next.message } : {}),
          ...(next.visible !== undefined ? { visible: next.visible } : {}),
        }, sessionId);
      },
      setWorkingVisible: (visible) => {
        const existing = extensionWorkingBySession.get(sessionId) ?? {};
        const next = { ...existing };
        if (typeof visible === 'boolean') {
          next.visible = visible;
        } else {
          delete next.visible;
        }
        if (next.message === undefined && next.visible === undefined) {
          extensionWorkingBySession.delete(sessionId);
        } else {
          extensionWorkingBySession.set(sessionId, next);
        }
        publishForSession('extension.working', {
          ...(next.message !== undefined ? { message: next.message } : {}),
          ...(next.visible !== undefined ? { visible: next.visible } : {}),
        }, sessionId);
      },
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (value) => {
        const title = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_EXTENSION_TITLE_CHARS);
        if (title) extensionTitlesBySession.set(sessionId, title);
        else extensionTitlesBySession.delete(sessionId);
        publishForSession('extension.title', title ? { title } : {}, sessionId);
      },
      custom: async () => undefined,
      // The browser inserts pasted text at its selection; the mirror appends.
      // The revision is intentionally left unchanged (browser revisions are
      // client-clock based, so a daemon bump could reject a skewed client): any
      // divergence or older in-flight update is corrected by the browser's next
      // draft sync, which follows the paste/set it applies.
      pasteToEditor: (value) => {
        const text = String(value ?? '').slice(0, MAX_EXTENSION_EDITOR_TEXT_CHARS);
        const current = extensionDraftBySession.get(sessionId);
        const currentText = current?.text ?? '';
        const nextText = (currentText + text).slice(0, MAX_EXTENSION_EDITOR_TEXT_CHARS);
        extensionDraftBySession.set(sessionId, {
          text: nextText,
          revision: current?.revision ?? 0,
        });
        publishForSession('extension.editor', {
          text,
          mode: 'paste',
        }, sessionId);
      },
      setEditorText: (value) => {
        const text = String(value ?? '').slice(0, MAX_EXTENSION_EDITOR_TEXT_CHARS);
        const current = extensionDraftBySession.get(sessionId);
        extensionDraftBySession.set(sessionId, {
          text,
          revision: current?.revision ?? 0,
        });
        publishForSession('extension.editor', {
          text,
          mode: 'set',
        }, sessionId);
      },
      getEditorText: () => {
        if (!extensionDraftTrackedSessions.has(sessionId)) {
          extensionDraftTrackedSessions.add(sessionId);
          publishForSession('extension.editor.track', { enabled: true }, sessionId);
        }
        return extensionDraftBySession.get(sessionId)?.text ?? '';
      },
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Theme switching is not supported in PiChamber sessions.' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      // Extensions style status/widget strings with Theme helpers. Semantic
      // colors are encoded as truecolor escape markers decoded by PiChamber UI.
      get theme() {
        return extensionTheme;
      },
    };
  };

  const reloadSession = async (session) => {
    clearExtensionState(session.sessionId);
    const providerObserver = session.modelRuntime?.[PROVIDER_OBSERVER];
    if (providerObserver) providerObserver.suppress = true;
    try {
      await session.reload();
    } finally {
      if (providerObserver) providerObserver.suppress = false;
    }
    const entries = session.sessionManager?.getBranch?.() ?? session.sessionManager?.getEntries?.();
    rebuildSessionPanelsAndApps(session.sessionId, Array.isArray(entries) ? entries : []);
    publishCatalogChange(session.sessionId, { providers: true, resources: true, commands: true });
  };

  const buildExtensionBindings = (session) => {
    installMutationObservers(session);
    return {
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
          if (result?.cancelled !== true) {
            const entries = session.sessionManager?.getBranch?.() ?? session.sessionManager?.getEntries?.();
            rebuildSessionPanelsAndApps(session.sessionId, Array.isArray(entries) ? entries : []);
          }
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, switchOptions) => {
          const owner = findRuntimeBySessionId(session.sessionId);
          if (!owner) throw new Error('Session runtime is no longer available.');
          return owner.switchSession(sessionPath, switchOptions);
        },
        reload: () => reloadSession(session),
      },
      shutdownHandler: () => requestSessionShutdown?.(session.sessionId),
      onError: (error) => {
        publishForSession('extension.error', {
          // Publish the extension display name instead of the server path.
          source: typeof error?.extensionPath === 'string' && error.extensionPath.length > 0
            ? resolveExtensionName(session, error.extensionPath)
            : 'unknown',
          ...(typeof error?.event === 'string' ? { event: error.event } : {}),
          message: String(error?.error ?? 'Unknown extension error.'),
        }, session.sessionId);
      },
    };
  };


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
    // A throwing renderer never breaks publication: the message still goes
    // out with text/details and other sessions are unaffected.
    let render;
    try {
      const ownerSession = findRuntimeBySessionId(sessionId)?.session;
      if (ownerSession && typeof renderExtensionMessage === 'function') {
        render = renderExtensionMessage(ownerSession, message);
      }
    } catch {
      render = undefined;
    }
    publish('extension.message', {
      id: `custom-${sessionId}-${getSequence() + 1}`,
      customType: message.customType,
      text: redactAttachmentPaths(text),
      ...(message.details !== undefined ? { details: redactAttachmentValues(message.details) } : {}),
      ...(render ? { render } : {}),
      createdAt: timestamp,
    }, sessionId, directory);
  };

  const setNormalizedPanel = (sessionId, descriptor) => {
    const id = typeof descriptor.id === 'string' && descriptor.id.length > 0 ? descriptor.id.slice(0, 128) : '';
    if (!id) return undefined;
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
    return { id, removed, normalized };
  };

  // Mirrors a declarative `pichamber.ui` descriptor into normalized panel
  // state and publishes an `extension.ui` event. Latest wins per stable id;
  // `removed: true` (or a payload without component/title) unregisters.
  const mirrorExtensionPanel = (sessionId, descriptor, directory) => {
    const result = setNormalizedPanel(sessionId, descriptor);
    if (!result) return;
    publish('extension.ui', result.removed ? { id: result.id, removed: true } : result.normalized, sessionId, directory);
  };

  const setNormalizedApp = (sessionId, descriptor) => {
    const appId = typeof descriptor.appId === 'string' && descriptor.appId.length > 0
      ? descriptor.appId.slice(0, 128)
      : (typeof descriptor.id === 'string' && descriptor.id.length > 0 ? descriptor.id.slice(0, 128) : '');
    if (!appId) return undefined;
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
    return {
      appId,
      removed,
      app: removed ? undefined : {
        appId,
        ...(typeof descriptor.title === 'string' ? { title: descriptor.title.slice(0, 256) } : {}),
        html,
      },
    };
  };

  // Mirrors a `pichamber.app` descriptor into normalized app state and
  // publishes an `extension.app` event. HTML is capped; removal unregisters.
  const mirrorExtensionApp = (sessionId, descriptor, directory) => {
    const result = setNormalizedApp(sessionId, descriptor);
    if (!result) return;
    publish('extension.app', {
      appId: result.appId,
      ...(result.removed ? { removed: true } : {
        ...(typeof descriptor.title === 'string' ? { title: descriptor.title.slice(0, 256) } : {}),
        html: descriptor.html && typeof descriptor.html === 'string' && descriptor.html.length > MAX_EXTENSION_APP_HTML_CHARS ? descriptor.html.slice(0, MAX_EXTENSION_APP_HTML_CHARS) : descriptor.html,
      }),
    }, sessionId, directory);
  };

  // Replays persisted custom entries on the active branch without publishing
  // events to restore live panel and app state across restarts and branch switches.
  const rebuildSessionPanelsAndApps = (sessionId, entries) => {
    if (!sessionId) return;
    extensionPanelsBySession.delete(sessionId);
    extensionAppsBySession.delete(sessionId);
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry?.type !== 'custom' || !isDisplayedExtensionEntryType(entry.customType)) continue;
      const descriptor = extractExtensionDescriptor(entry);
      if (!descriptor) continue;
      if (entry.customType === 'pichamber.app') {
        setNormalizedApp(sessionId, descriptor);
      } else {
        setNormalizedPanel(sessionId, descriptor);
      }
    }
  };

  const updateExtensionDraft = (sessionId, text, revision) => {
    if (typeof sessionId !== 'string' || !sessionId) return { accepted: false };
    if (!extensionDraftTrackedSessions.has(sessionId)) return { accepted: false };
    if (typeof text !== 'string' || text.length > MAX_EXTENSION_EDITOR_TEXT_CHARS) return { accepted: false };
    if (!Number.isSafeInteger(revision) || revision < 0) return { accepted: false };
    const current = extensionDraftBySession.get(sessionId);
    if (current && Number.isSafeInteger(current.revision) && revision <= current.revision) {
      return { accepted: false };
    }
    extensionDraftBySession.set(sessionId, { text, revision });
    return { accepted: true };
  };

  const resetExtensionDraft = (sessionId) => {
    if (!sessionId) return;
    // Untracked sessions without a mirror stay untouched, so ordinary prompts
    // never allocate draft state.
    const current = extensionDraftBySession.get(sessionId);
    if (current) extensionDraftBySession.set(sessionId, { text: '', revision: current.revision });
  };

  const getSnapshotState = (sessionId) => {
    if (!sessionId) return {};
    const statuses = extensionStatusesBySession.get(sessionId);
    const widgets = extensionWidgetsBySession.get(sessionId);
    const panels = extensionPanelsBySession.get(sessionId);
    const apps = extensionAppsBySession.get(sessionId);
    const title = extensionTitlesBySession.get(sessionId);
    const dialogs = [...pendingExtensionDialogs.values()]
      .filter((pending) => pending.sessionId === sessionId)
      .map((pending) => pending.payload);
    const working = extensionWorkingBySession.get(sessionId);
    const draftTracked = extensionDraftTrackedSessions.has(sessionId);
    return {
      ...(statuses?.size ? { statuses: [...statuses.entries()].map(([key, text]) => ({ key, text })) } : {}),
      ...(widgets?.size ? { widgets: [...widgets.entries()].map(([key, widget]) => ({ key, ...widget })) } : {}),
      ...(dialogs.length ? { dialogs } : {}),
      ...(panels?.size ? { panels: [...panels.values()] } : {}),
      ...(apps?.size ? { apps: [...apps.values()] } : {}),
      ...(title ? { title } : {}),
      ...(working ? { working: { ...working } } : {}),
      ...(draftTracked ? { draftTracked: true } : {}),
    };
  };

  return {
    buildExtensionBindings,
    clearExtensionState,
    getSnapshotState,
    mirrorExtensionApp,
    mirrorExtensionPanel,
    rebuildSessionPanelsAndApps,
    publishExtensionCustomMessage,
    reloadSession,
    resetExtensionDraft,
    resolveExtensionDialog,
    updateExtensionDraft,
  };
};
