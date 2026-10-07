import { renderComponentLines } from './extension-tool-render.js';

// Daemon-side rendering for `pi.registerMessageRenderer(customType, renderer)`.
// Mirrors the Pi terminal: the renderer is called with the full custom message,
// `{ expanded, outputPad: 0 }`, and the shared extension theme, once collapsed
// and once expanded. A throwing/missing renderer never throws out of here; the
// caller publishes the message with text/details as usual.
export const createExtensionMessageRenderer = ({ theme, redactAttachmentPaths = (value) => value } = {}) => {
  // Memoized per persisted entry object: one entry belongs to one history
  // item, so its renderer input never varies. The owning session is part of
  // the key so a session replacement re-renders instead of reusing stale lines.
  const settledMemo = new WeakMap();

  const resolveRenderer = (session, customType) => {
    if (!session || typeof customType !== 'string' || customType.length === 0) return undefined;
    try {
      const getMessageRenderer = session?.extensionRunner?.getMessageRenderer;
      if (typeof getMessageRenderer !== 'function') return undefined;
      const renderer = getMessageRenderer.call(session.extensionRunner, customType);
      return typeof renderer === 'function' ? renderer : undefined;
    } catch {
      return undefined;
    }
  };

  const renderSlot = (renderer, message, expanded) => {
    try {
      const component = renderer(message, { expanded, outputPad: 0 }, theme);
      if (!component) return undefined;
      const lines = renderComponentLines(component);
      if (!lines || lines.length === 0) return undefined;
      return lines.map((line) => redactAttachmentPaths(line));
    } catch {
      return undefined;
    }
  };

  const renderMessage = (session, message) => {
    if (!message || typeof message.customType !== 'string' || message.customType.length === 0) return undefined;
    const renderer = resolveRenderer(session, message.customType);
    if (!renderer) return undefined;
    const collapsed = renderSlot(renderer, message, false);
    if (!collapsed || collapsed.length === 0) return undefined;
    const render = { message: collapsed };
    const expanded = renderSlot(renderer, message, true);
    if (expanded && expanded.length > 0
      && !(expanded.length === collapsed.length && expanded.every((line, index) => line === collapsed[index]))) {
      render.messageExpanded = expanded;
    }
    return render;
  };

  // Build the renderer input from a persisted `custom_message` entry so the
  // renderer sees identical input live and on replay.
  const renderEntry = (session, entry) => {
    if (!entry || typeof entry !== 'object') return undefined;
    const cached = settledMemo.get(entry);
    if (cached && cached.session === session) return cached.render;
    const timestamp = Date.parse(entry.timestamp);
    const message = {
      role: 'custom',
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
    const render = renderMessage(session, message);
    settledMemo.set(entry, { session, render });
    return render;
  };

  return { resolveRenderer, renderMessage, renderEntry };
};
