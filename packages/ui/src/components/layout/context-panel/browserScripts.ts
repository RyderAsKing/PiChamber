export const DESKTOP_BROWSER_INSPECT_SCRIPT = `new Promise((resolve) => {
  const existing = document.getElementById('__pichamber_desktop_browser_overlay');
  if (existing) existing.remove();
  if (typeof window.__pichamberDesktopBrowserCancelInspect === 'function') {
    try { window.__pichamberDesktopBrowserCancelInspect(); } catch { /* webview not ready */ }
  }
  const overlay = document.createElement('div');
  overlay.id = '__pichamber_desktop_browser_overlay';
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #60a5fa;background:rgba(96,165,250,.24);border-radius:3px;display:none;box-sizing:border-box;';
  document.documentElement.appendChild(overlay);
  const cssEscape = (value) => {
    try { return CSS.escape(value); } catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); }
  };
  const selectorPart = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return tag + '#' + cssEscape(element.id);
    const className = String(element.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((part) => '.' + cssEscape(part)).join('');
    return tag + className;
  };
  const metadata = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const ancestry = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 8) {
      ancestry.unshift({ tag: current.tagName.toLowerCase(), id: current.id || undefined, className: typeof current.className === 'string' ? current.className : undefined, selectorPart: selectorPart(current) });
      current = current.parentElement;
    }
    const attrs = {};
    for (const attr of Array.from(element.attributes || []).slice(0, 16)) attrs[attr.name] = attr.value.slice(0, 300);
    const path = ancestry.map((entry) => entry.selectorPart).join(' > ');
    return {
      frame: 'top',
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      selector: element.id ? '#' + cssEscape(element.id) : path,
      path,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      attributes: attrs,
      computedStyle: { display: style.display, position: style.position, fontWeight: style.fontWeight, fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily, color: style.color, backgroundColor: style.backgroundColor, zIndex: style.zIndex },
      ancestry,
    };
  };
  const move = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === overlay || element === document.documentElement || element === document.body) return;
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  };
  const cleanup = () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('click', click, true);
    window.removeEventListener('keydown', keydown, true);
    if (window.__pichamberDesktopBrowserCancelInspect === cancel) {
      delete window.__pichamberDesktopBrowserCancelInspect;
    }
  };
  const cancel = () => {
    cleanup();
    overlay.remove();
    resolve(null);
  };
  const click = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const result = element ? metadata(element) : null;
    cleanup();
    overlay.remove();
    resolve(result);
  };
  const keydown = (event) => {
    if (event.key !== 'Escape') return;
    cancel();
  };
  window.__pichamberDesktopBrowserCancelInspect = cancel;
  window.addEventListener('mousemove', move, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', keydown, true);
});`;

export const DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT = `(() => {
  if (typeof window.__pichamberDesktopBrowserCancelInspect === 'function') {
    window.__pichamberDesktopBrowserCancelInspect();
    return;
  }
  const overlay = document.getElementById('__pichamber_desktop_browser_overlay');
  if (overlay) overlay.remove();
})()`;

export const DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT = `(() => {
  if (window.__pichamberSameWebviewNavigationInstalled) return;
  window.__pichamberSameWebviewNavigationInstalled = true;

  const navigate = (rawUrl) => {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      window.location.assign(url.href);
      return true;
    } catch (_error) {
      return false;
    }
  };

  const originalOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    if (navigate(url)) return null;
    return originalOpen(url, target, features);
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[target="_blank"][href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!navigate(anchor.href)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
})()`;

export const normalizeBrowserUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'about:blank';
    return parsed.toString();
  } catch {
    return 'about:blank';
  }
};

export const runIframeScript = async <T,>(iframe: HTMLIFrameElement, script: string): Promise<T> => {
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) {
    throw new Error('Iframe window is not available');
  }

  const evaluate = (frameWindow as Window & { eval: (code: string) => unknown }).eval;
  const result = evaluate.call(frameWindow, script) as unknown;
  return await Promise.resolve(result) as T;
};


