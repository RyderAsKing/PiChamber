export const isPreviewCaptureDebugEnabled = (): boolean => {
  try {
    return Boolean((window as unknown as { __previewCaptureDebug?: boolean }).__previewCaptureDebug);
  } catch {
    return false;
  }
};

export const previewCaptureDebug = (...args: unknown[]): void => {
  if (!isPreviewCaptureDebugEnabled()) return;
  console.info('[preview-capture]', ...args);
};

export type ScrolledElementInfo = {
  selector: string;
  scrollTop: number;
  scrollLeft: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
};

export const describeScrolledElements = (doc: Document, limit = 8): ScrolledElementInfo[] => {
  const found: ScrolledElementInfo[] = [];
  try {
    const all = doc.querySelectorAll<HTMLElement>('*');
    for (const el of all) {
      const scrollTop = el.scrollTop || 0;
      const scrollLeft = el.scrollLeft || 0;
      if (scrollTop <= 0 && scrollLeft <= 0) continue;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      found.push({
        selector: `${tag}${id}${cls}`,
        scrollTop,
        scrollLeft,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
      });
      if (found.length >= limit) break;
    }
  } catch { /* best-effort diagnostics */ }
  return found;
};

export const FIXED_PIN_ATTR = 'data-oc-fixed-pin';

export const tagFixedElementsForClonePinning = (doc: Document, scrollX: number, scrollY: number): (() => void) => {
  if (scrollX <= 0 && scrollY <= 0) return () => { /* nothing scrolled */ };
  const view = doc.defaultView;
  if (!view) return () => { /* no view */ };
  const tagged: HTMLElement[] = [];
  const debugInfo: Array<Record<string, number | string>> = [];
  try {
    for (const el of doc.querySelectorAll<HTMLElement>('*')) {
      if (view.getComputedStyle(el).position !== 'fixed') continue;
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      el.setAttribute(FIXED_PIN_ATTR, JSON.stringify({
        top: rect.top + scrollY,
        left: rect.left + scrollX,
        width: rect.width,
        height: rect.height,
      }));
      tagged.push(el);
      const tag = el.tagName.toLowerCase();
      const cls = typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      debugInfo.push({ selector: `${tag}${cls}`, top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) });
    }
  } catch { /* best-effort: leave fixed elements untagged */ }
  previewCaptureDebug('tagged fixed elements', debugInfo);
  return () => {
    for (const el of tagged) {
      try { el.removeAttribute(FIXED_PIN_ATTR); } catch { /* best-effort */ }
    }
  };
};

export const snapdomFixedPinPlugin = {
  name: 'oc-fixed-pin',
  afterClone(context: { clone?: Element | null }): void {
    const clone = context?.clone;
    if (!clone || typeof (clone as Element).querySelectorAll !== 'function') return;
    for (const el of (clone as Element).querySelectorAll<HTMLElement>(`[${FIXED_PIN_ATTR}]`)) {
      let spec: { top: number; left: number; width: number; height: number };
      try { spec = JSON.parse(el.getAttribute(FIXED_PIN_ATTR) || ''); } catch { continue; }
      el.style.setProperty('position', 'absolute', 'important');
      el.style.setProperty('top', `${spec.top}px`, 'important');
      el.style.setProperty('left', `${spec.left}px`, 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('width', `${spec.width}px`, 'important');
      el.style.setProperty('height', `${spec.height}px`, 'important');
      el.removeAttribute(FIXED_PIN_ATTR);
    }
  },
};

export const NESTED_SCROLL_ATTR = 'data-oc-scroll-pin';

export const captureNestedScrollState = (doc: Document): { reapply: () => void; cleanup: () => void; snapshot: ScrolledElementInfo[] } => {
  const entries: Array<{ el: HTMLElement; top: number; left: number; tagged: boolean }> = [];
  const snapshot = describeScrolledElements(doc, 64);
  try {
    const root = doc.documentElement;
    const body = doc.body;
    for (const el of doc.querySelectorAll<HTMLElement>('*')) {
      const top = el.scrollTop || 0;
      const left = el.scrollLeft || 0;
      if (top <= 0 && left <= 0) continue;
      const tagged = el !== root && el !== body;
      if (tagged) el.setAttribute(NESTED_SCROLL_ATTR, JSON.stringify({ top, left }));
      entries.push({ el, top, left, tagged });
    }
  } catch { /* best-effort: no nested scroll preservation */ }
  const reapply = () => {
    for (const entry of entries) {
      try {
        void entry.el.scrollHeight;
        if (entry.el.scrollTop !== entry.top) entry.el.scrollTop = entry.top;
        if (entry.el.scrollLeft !== entry.left) entry.el.scrollLeft = entry.left;
      } catch { /* best-effort restore */ }
    }
  };
  const cleanup = () => {
    for (const entry of entries) {
      if (!entry.tagged) continue;
      try { entry.el.removeAttribute(NESTED_SCROLL_ATTR); } catch { /* best-effort */ }
    }
  };
  return { reapply, cleanup, snapshot };
};

export const snapdomNestedScrollPlugin = {
  name: 'oc-nested-scroll',
  afterClone(context: { clone?: Element | null }): void {
    const clone = context?.clone;
    if (!clone || typeof (clone as Element).querySelectorAll !== 'function') return;
    const ownerDoc = (clone as Element).ownerDocument;
    if (!ownerDoc) return;
    for (const el of (clone as Element).querySelectorAll<HTMLElement>(`[${NESTED_SCROLL_ATTR}]`)) {
      let spec: { top: number; left: number };
      try { spec = JSON.parse(el.getAttribute(NESTED_SCROLL_ATTR) || ''); } catch { el.removeAttribute(NESTED_SCROLL_ATTR); continue; }
      const transform = `translate(${-spec.left}px, ${-spec.top}px)`;
      const existingWrapper = el.children.length === 1 && el.firstElementChild instanceof HTMLElement && el.firstElementChild.style.willChange === 'transform'
        ? el.firstElementChild
        : null;
      if (existingWrapper) {
        existingWrapper.style.transform = transform;
      } else {
        el.style.overflow = 'hidden';
        const inner = ownerDoc.createElement('div');
        inner.style.transform = transform;
        inner.style.willChange = 'transform';
        inner.style.display = 'inline-block';
        inner.style.width = '100%';
        while (el.firstChild) inner.appendChild(el.firstChild);
        el.appendChild(inner);
      }
      el.removeAttribute(NESTED_SCROLL_ATTR);
    }
  },
};
