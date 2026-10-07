export const TOOL_RENDER_WIDTH = 100;
export const MAX_TOOL_RENDER_LINES = 200;
export const MAX_TOOL_RENDER_LINE_CHARS = 2000;
export const TOOL_RENDER_THROTTLE_MS = 250;

const THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme');
const THEME_KEY_OLD = Symbol.for('@mariozechner/pi-coding-agent:theme');

export function installExtensionGlobalTheme(theme) {
  if (!globalThis[THEME_KEY]) {
    globalThis[THEME_KEY] = theme;
    globalThis[THEME_KEY_OLD] = theme;
  }
}

const sanitizeLines = (lines) => {
  if (!Array.isArray(lines)) return undefined;
  const sanitized = [];
  const limit = Math.min(lines.length, MAX_TOOL_RENDER_LINES);
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    if (line !== undefined && line !== null) {
      // pi-tui pads lines to the render width; the UI wraps nothing, so drop the padding.
      sanitized.push(String(line).replace(/ +$/, '').slice(0, MAX_TOOL_RENDER_LINE_CHARS));
    } else {
      sanitized.push('');
    }
  }
  return sanitized.length > 0 ? sanitized : undefined;
};

// Render one TUI component to sanitized ANSI lines. Shared by tool renders
// and extension message renders so both sides keep the same width and bounds.
export const renderComponentLines = (component, width = TOOL_RENDER_WIDTH) => {
  try {
    if (!component || typeof component.render !== 'function') return undefined;
    return sanitizeLines(component.render(width));
  } catch {
    return undefined;
  }
};

export function createExtensionToolRenderer({
  theme,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now,
} = {}) {
  const entries = new Map();
  const settledMemo = new WeakMap();

  const renderCallSlot = (entry, definition, args, cwd) => {
    if (typeof definition?.renderCall !== 'function') return undefined;
    try {
      const context = {
        args,
        toolCallId: entry.toolCallId || '',
        invalidate: () => scheduleTrailing(entry),
        lastComponent: entry.lastComponents?.call,
        state: entry.state || {},
        cwd: cwd || '',
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: false,
        isError: false,
      };
      const component = definition.renderCall(args, theme, context);
      if (entry.lastComponents) entry.lastComponents.call = component;
      return renderComponentLines(component);
    } catch {}
    return undefined;
  };

  const renderResultSlot = (entry, definition, result, { expanded = false, isPartial = false, isError = false, args, cwd } = {}) => {
    if (typeof definition?.renderResult !== 'function') return undefined;
    const slot = expanded ? 'resultExpanded' : 'result';
    try {
      const context = {
        args: args ?? entry.latest?.args,
        toolCallId: entry.toolCallId || '',
        invalidate: () => scheduleTrailing(entry),
        lastComponent: entry.lastComponents?.[slot],
        state: entry.state || {},
        cwd: cwd || '',
        executionStarted: true,
        argsComplete: true,
        isPartial,
        expanded,
        showImages: false,
        isError,
      };
      const component = definition.renderResult(result, { expanded, isPartial }, theme, context);
      if (entry.lastComponents) entry.lastComponents[slot] = component;
      return renderComponentLines(component);
    } catch {}
    return undefined;
  };

  const scheduleTrailing = (entry) => {
    if (!entry || entry.timer || !entry.latest?.publish) return;
    const elapsed = now() - entry.lastRenderAt;
    const delay = Math.max(0, TOOL_RENDER_THROTTLE_MS - elapsed);
    entry.timer = schedule(() => {
      entry.timer = undefined;
      entry.lastRenderAt = now();
      const latest = entry.latest;
      if (!latest || typeof latest.publish !== 'function' || !latest.definition) return;
      const { definition, args, cwd, result, isError, publish } = latest;

      const render = renderPartial(entry, definition, { args, cwd, result, isError: isError ?? false });
      if (render) {
        publish(render);
      }
    }, delay);
  };

  // Partial renders include the expanded slot too, so an expanded row never shows
  // the collapsed render (and its "expand" hints) while the tool is still running.
  const renderPartial = (entry, definition, { args, cwd, result, isError }) => {
    if (entry.callLines === undefined && typeof definition?.renderCall === 'function') {
      entry.callLines = renderCallSlot(entry, definition, args, cwd);
    }
    const options = { isPartial: true, isError, args, cwd };
    const resultLines = renderResultSlot(entry, definition, result, { ...options, expanded: false });
    const resultExpandedLines = renderResultSlot(entry, definition, result, { ...options, expanded: true });

    const render = {};
    if (entry.callLines && entry.callLines.length > 0) render.call = entry.callLines;
    if (resultLines && resultLines.length > 0) render.result = resultLines;
    if (resultExpandedLines && resultExpandedLines.length > 0) render.resultExpanded = resultExpandedLines;
    if (Object.keys(render).length === 0) return undefined;
    entry.liveRender = render;
    return render;
  };

  const resolve = (session, toolName) => {
    if (!session || typeof toolName !== 'string') return undefined;
    try {
      const getToolDef = session?.extensionRunner?.getToolDefinition;
      if (typeof getToolDef !== 'function') return undefined;
      const def = getToolDef.call(session.extensionRunner, toolName);
      if (!def || typeof def !== 'object') return undefined;
      if (typeof def.renderCall === 'function' || typeof def.renderResult === 'function') {
        return def;
      }
    } catch {}
    return undefined;
  };

  const renderCall = (entryOrCtx, definition, args, cwd) => {
    const entry = entryOrCtx && typeof entryOrCtx === 'object' ? entryOrCtx : { state: {}, lastComponents: {}, toolCallId: '' };
    return renderCallSlot(entry, definition, args, cwd);
  };

  const renderResult = (entryOrCtx, definition, result, options = {}) => {
    const entry = entryOrCtx && typeof entryOrCtx === 'object' ? entryOrCtx : { state: {}, lastComponents: {}, toolCallId: '' };
    return renderResultSlot(entry, definition, result, options);
  };

  const onStart = ({ sessionId, toolCallId, definition, args, cwd }) => {
    const key = `${sessionId}\u0000${toolCallId}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        sessionId,
        toolCallId,
        state: {},
        lastComponents: { call: undefined, result: undefined, resultExpanded: undefined },
        callLines: undefined,
        lastRenderAt: 0,
        timer: undefined,
        latest: undefined,
      };
      entries.set(key, entry);
    }
    entry.lastRenderAt = now();
    if (typeof definition?.renderCall === 'function') {
      entry.callLines = renderCallSlot(entry, definition, args, cwd);
    }
    if (entry.callLines && entry.callLines.length > 0) {
      entry.liveRender = { call: entry.callLines };
      return entry.liveRender;
    }
    return undefined;
  };

  // Latest render published for a running tool, so a client that opens the
  // session mid-run sees the working state without waiting for the next update.
  const getLiveRender = (sessionId, toolCallId) => entries.get(`${sessionId}\u0000${toolCallId}`)?.liveRender;

  const onUpdate = ({ sessionId, toolCallId, definition, args, cwd, partialResult, publish }) => {
    const key = `${sessionId}\u0000${toolCallId}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        sessionId,
        toolCallId,
        state: {},
        lastComponents: { call: undefined, result: undefined, resultExpanded: undefined },
        callLines: undefined,
        lastRenderAt: 0,
        timer: undefined,
        latest: undefined,
      };
      entries.set(key, entry);
    }

    entry.latest = {
      definition,
      args,
      cwd,
      result: partialResult,
      isError: false,
      publish,
    };

    const currentTime = now();
    if (currentTime - entry.lastRenderAt >= TOOL_RENDER_THROTTLE_MS) {
      if (entry.timer) {
        cancel(entry.timer);
        entry.timer = undefined;
      }
      entry.lastRenderAt = currentTime;

      return renderPartial(entry, definition, { args, cwd, result: partialResult, isError: false });
    }

    scheduleTrailing(entry);
    return undefined;
  };

  const onEnd = ({ sessionId, toolCallId, definition, args, cwd, result, isError }) => {
    const key = `${sessionId}\u0000${toolCallId}`;
    const entry = entries.get(key) || {
      sessionId,
      toolCallId,
      state: {},
      lastComponents: { call: undefined, result: undefined, resultExpanded: undefined },
      callLines: undefined,
      lastRenderAt: 0,
      timer: undefined,
      latest: undefined,
    };

    if (entry.timer) {
      cancel(entry.timer);
      entry.timer = undefined;
    }
    entries.delete(key);
    entry.latest = undefined;

    let call = entry.callLines;
    if (call === undefined && typeof definition?.renderCall === 'function') {
      call = renderCallSlot(entry, definition, args, cwd);
    }

    const resultCollapsed = renderResultSlot(entry, definition, result, {
      expanded: false,
      isPartial: false,
      isError: isError === true,
      args,
      cwd,
    });

    const resultExpanded = renderResultSlot(entry, definition, result, {
      expanded: true,
      isPartial: false,
      isError: isError === true,
      args,
      cwd,
    });

    const render = {};
    if (call && call.length > 0) render.call = call;
    if (resultCollapsed && resultCollapsed.length > 0) render.result = resultCollapsed;
    if (resultExpanded && resultExpanded.length > 0) render.resultExpanded = resultExpanded;

    return Object.keys(render).length > 0 ? render : undefined;
  };

  // Memoized by the toolResult message alone: one result object belongs to one
  // history entry, so its tool call's args, cwd, and isError never vary.
  const renderSettled = (definition, { toolCallId, args, cwd, result, isError }) => {
    if (result && (typeof result === 'object' || typeof result === 'function')) {
      if (settledMemo.has(result)) {
        return settledMemo.get(result);
      }
    }

    const entry = {
      toolCallId,
      state: {},
      lastComponents: { call: undefined, result: undefined, resultExpanded: undefined },
    };

    let call;
    if (typeof definition?.renderCall === 'function') {
      call = renderCallSlot(entry, definition, args, cwd);
    }

    let resultCollapsed;
    let resultExpanded;
    if (typeof definition?.renderResult === 'function') {
      resultCollapsed = renderResultSlot(entry, definition, result, {
        expanded: false,
        isPartial: false,
        isError: isError === true,
        args,
        cwd,
      });
      resultExpanded = renderResultSlot(entry, definition, result, {
        expanded: true,
        isPartial: false,
        isError: isError === true,
        args,
        cwd,
      });
    }

    const render = {};
    if (call && call.length > 0) render.call = call;
    if (resultCollapsed && resultCollapsed.length > 0) render.result = resultCollapsed;
    if (resultExpanded && resultExpanded.length > 0) render.resultExpanded = resultExpanded;

    const output = Object.keys(render).length > 0 ? render : undefined;
    if (result && (typeof result === 'object' || typeof result === 'function')) {
      settledMemo.set(result, output);
    }
    return output;
  };

  const clearSession = (sessionId) => {
    if (typeof sessionId !== 'string') return;
    const prefix = `${sessionId}\u0000`;
    for (const [key, entry] of entries.entries()) {
      if (key.startsWith(prefix)) {
        if (entry.timer) {
          cancel(entry.timer);
          entry.timer = undefined;
        }
        entry.latest = undefined;
        entries.delete(key);
      }
    }
  };

  const dispose = () => {
    for (const entry of entries.values()) {
      if (entry.timer) {
        cancel(entry.timer);
        entry.timer = undefined;
      }
      entry.latest = undefined;
    }
    entries.clear();
  };

  return {
    resolve,
    renderCall,
    renderResult,
    onStart,
    onUpdate,
    onEnd,
    getLiveRender,
    renderSettled,
    clearSession,
    dispose,
  };
}
