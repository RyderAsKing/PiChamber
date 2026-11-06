/**
 * Scripts the server browser runs in a page. They run in an isolated world:
 * the page's own scripts cannot see or change them.
 */

const WORLD_NAME = 'pichamber-server-browser';

const COPY_TEXT_LIMIT = 1_000_000;

/**
 * Records what a Ctrl or Cmd + C or X copies, for the device's clipboard
 * (headless Chrome has none of its own): the selection, or the text a page
 * handler puts on the clipboard instead. Installed in every document before
 * the page's scripts run.
 */
const COPY_RECORDER = `(() => {
  if (globalThis.takeCopy) return;
  let keying = false;
  let copied = '';
  addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'c' && key !== 'x') return;
    keying = true;
    copied = '';
    setTimeout(() => { keying = false; });
  }, true);
  const selection = () => {
    let field = document.activeElement;
    while (field && field.shadowRoot && field.shadowRoot.activeElement) field = field.shadowRoot.activeElement;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null) {
      return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart);
    }
    return String(document.getSelection() ?? '');
  };
  const record = (text) => { copied = String(text ?? '').slice(0, ${COPY_TEXT_LIMIT}); };
  // Capturing at the window runs before page handlers can stop the event,
  // and before cut removes the selection.
  const snapshot = (event) => { if (keying && event.isTrusted) record(selection()); };
  // Bubbling back to the window picks up text a page handler set instead.
  const replace = (event) => {
    if (keying && event.isTrusted && event.defaultPrevented) record(event.clipboardData && event.clipboardData.getData('text/plain'));
  };
  for (const type of ['copy', 'cut']) {
    addEventListener(type, snapshot, true);
    addEventListener(type, replace);
  }
  globalThis.takeCopy = () => { const text = copied; copied = ''; return text; };
})()`;

/** The binding the title watcher reports through; only the isolated world has it. */
export const TITLE_BINDING = 'pichamberTitleChanged';

/**
 * Reports the main frame's title whenever the page changes it after loading
 * (Chrome sends no event for that). It watches the title element and the
 * elements that hold it, not the whole document, so busy pages pay nothing.
 */
const TITLE_WATCHER = `(() => {
  if (globalThis.watchingTitle || window !== window.top) return;
  const report = globalThis.${TITLE_BINDING};
  if (typeof report !== 'function') return;
  globalThis.watchingTitle = true;
  let last = document.title;
  let watched = [];
  const check = () => {
    const holders = [document, document.documentElement, document.head].filter(Boolean);
    const title = document.querySelector('title');
    const next = title ? [...holders, title] : holders;
    if (next.length !== watched.length || next.some((node, index) => node !== watched[index])) {
      observer.disconnect();
      for (const node of next) observer.observe(node, node === title ? { childList: true, characterData: true, subtree: true } : { childList: true });
      watched = next;
    }
    if (document.title === last) return;
    last = document.title;
    report(last);
  };
  const observer = new MutationObserver(check);
  check();
  // The head may not exist yet when this runs.
  document.addEventListener('DOMContentLoaded', check, { once: true });
})()`;

/** What the element at a point is, for Inspect. */
export const ELEMENT_METADATA_FUNCTION = `function (x, y) {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (!element) return null;
  const cssEscape = (value) => { try { return CSS.escape(value); } catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); } };
  const selectorPart = (node) => {
    const tag = node.tagName.toLowerCase();
    if (node.id) return tag + '#' + cssEscape(node.id);
    const className = String(node.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((part) => '.' + cssEscape(part)).join('');
    return tag + className;
  };
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const ancestry = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 8) {
    ancestry.unshift({ tag: current.tagName.toLowerCase(), id: current.id || undefined, className: typeof current.className === 'string' ? current.className : undefined, selectorPart: selectorPart(current) });
    current = current.parentElement;
  }
  const attributes = {};
  for (const attr of Array.from(element.attributes || []).slice(0, 16)) attributes[attr.name] = attr.value.slice(0, 300);
  const path = ancestry.map((entry) => entry.selectorPart).join(' > ');
  return {
    frame: 'top',
    tag: element.tagName.toLowerCase(),
    text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
    selector: element.id ? '#' + cssEscape(element.id) : path,
    path,
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    attributes,
    computedStyle: { display: style.display, position: style.position, fontWeight: style.fontWeight, fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily, color: style.color, backgroundColor: style.backgroundColor, zIndex: style.zIndex },
    ancestry,
  };
}`;

/** The mouse cursor the page shows at a point. */
export const CURSOR_FUNCTION = `function (x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element) return 'default';
  const cursor = getComputedStyle(element).cursor;
  if (cursor && cursor !== 'auto' && !cursor.startsWith('url(')) return cursor.split(',').pop().trim();
  if (element.closest('a[href], button, [role="button"], summary, label[for]')) return 'pointer';
  if (element.isContentEditable || element.tagName === 'TEXTAREA') return 'text';
  if (element.tagName === 'INPUT' && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(element.type)) return 'text';
  return 'default';
}`;

const callExpression = (functionDeclaration, args) => `(${functionDeclaration})(${args.map((value) => JSON.stringify(value)).join(', ')})`;

/**
 * The isolated world of one page target: its main frame and the frames in
 * the same process. `send` is the page's CDP session.
 */
export const createPageWorld = (send) => {
  // Execution contexts by frame id; each navigation of a frame makes a new one.
  const contexts = new Map();
  let mainFrameId = null;

  const contextFor = async (frameId) => {
    if (contexts.has(frameId)) return contexts.get(frameId);
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME });
    contexts.set(frameId, executionContextId);
    return executionContextId;
  };

  const evaluate = async (frameId, expression) => {
    const run = async () => {
      const contextId = await contextFor(frameId);
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, contextId, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'Page script failed');
      return result.value;
    };
    try {
      return await run();
    } catch (error) {
      // The world went away with a navigation; make a new one once.
      if (!/context/i.test(error?.message || '')) throw error;
      contexts.delete(frameId);
      return await run();
    }
  };

  const frameIds = async () => {
    const { frameTree } = await send('Page.getFrameTree');
    const ids = [];
    const walk = (node) => {
      ids.push(node.frame.id);
      for (const child of node.childFrames || []) walk(child);
    };
    walk(frameTree);
    return ids;
  };

  return {
    async install(frameId) {
      mainFrameId = frameId;
      await send('Runtime.addBinding', { name: TITLE_BINDING, executionContextName: WORLD_NAME });
      await send('Page.addScriptToEvaluateOnNewDocument', { source: COPY_RECORDER, worldName: WORLD_NAME, runImmediately: true });
      await send('Page.addScriptToEvaluateOnNewDocument', { source: TITLE_WATCHER, worldName: WORLD_NAME, runImmediately: true });
    },

    /** A frame navigated: its world is new. */
    frameNavigated(frameId) {
      contexts.delete(frameId);
    },

    /** Runs `functionDeclaration(...args)` in the main frame. */
    call(functionDeclaration, args = []) {
      return evaluate(mainFrameId, callExpression(functionDeclaration, args));
    },

    /** The text the last copy or cut recorded, in whichever frame it ran. */
    async takeCopy() {
      const ids = await frameIds().catch(() => [mainFrameId]);
      const texts = await Promise.all(ids.map((frameId) => evaluate(frameId, 'globalThis.takeCopy ? globalThis.takeCopy() : ""').catch(() => '')));
      return texts.find((text) => typeof text === 'string' && text) || '';
    },
  };
};
