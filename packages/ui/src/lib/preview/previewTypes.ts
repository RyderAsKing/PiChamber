export type PreviewElementMetadata = {
  frame: 'top';
  tag: string;
  text: string;
  selector: string;
  path: string;
  bounds: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  attributes: Record<string, string>;
  computedStyle: Record<string, string>;
  ancestry: Array<{ tag: string; id?: string; className?: string; selectorPart: string }>;
};

const isXYRecord = (value: unknown): value is { x: number; y: number } => {
  if (!value || typeof value !== 'object') return false;
  const record = value as { x?: unknown; y?: unknown };
  return typeof record.x === 'number' && typeof record.y === 'number';
};

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
};

// Bridge messages arrive via postMessage from a (possibly untrusted) proxied page,
// so validate the full shape every downstream consumer touches — not just bounds.
// formatPreviewAnnotationMarkdown dereferences text/attributes/center/computedStyle/
// ancestry, so a partially-valid payload would otherwise throw at format time.
export const isPreviewElementMetadata = (value: unknown): value is PreviewElementMetadata => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PreviewElementMetadata>;
  const bounds = record.bounds;
  return typeof record.tag === 'string'
    && typeof record.text === 'string'
    && typeof record.selector === 'string'
    && typeof record.path === 'string'
    && Boolean(bounds)
    && typeof bounds?.x === 'number'
    && typeof bounds?.y === 'number'
    && typeof bounds?.width === 'number'
    && typeof bounds?.height === 'number'
    && isXYRecord(record.center)
    && isStringRecord(record.attributes)
    && isStringRecord(record.computedStyle)
    && Array.isArray(record.ancestry);
};

export const formatPreviewAnnotationMarkdown = ({
  pageUrl,
  viewport,
  devicePixelRatio,
  target,
  screenshotAttached,
  intro,
}: {
  pageUrl: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  target: PreviewElementMetadata;
  screenshotAttached: boolean;
  intro: string;
}): string => {
  const text = target.text.trim();
  const attributes = Object.entries(target.attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  const styles = target.computedStyle;
  const bounds = target.bounds;
  const center = target.center;
  const introLabel = intro.replace(/[.:]+$/g, '');
  const ancestry = target.ancestry
    .map((entry) => entry.selectorPart)
    .join(' > ');

  return [
    `${introLabel}:`,
    `Page: ${pageUrl || 'preview'}`,
    `Viewport: ${viewport.width}x${viewport.height}, DPR ${devicePixelRatio}`,
    `Screenshot: ${screenshotAttached ? 'attached' : 'not attached'}`,
    `Element: ${target.tag}`,
    text ? `Text: ${text}` : null,
    `- Selector: ${target.selector}`,
    `- Path: ${target.path}`,
    ancestry ? `- Ancestry: ${ancestry}` : null,
    attributes ? `- Attributes: ${attributes}` : null,
    `- Bounds: x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}, width=${Math.round(bounds.width)}, height=${Math.round(bounds.height)}`,
    `- Center: x=${Math.round(center.x)}, y=${Math.round(center.y)}`,
    `Styles: display=${styles.display}; position=${styles.position}; font=${styles.fontWeight} ${styles.fontSize} / ${styles.lineHeight} ${styles.fontFamily}; color=${styles.color}; background=${styles.backgroundColor}; z-index=${styles.zIndex}`,
  ].filter((line): line is string => typeof line === 'string').join('\n');
};

export type CachedProxyTarget = { proxyBasePath: string; previewToken?: string; expiresAt: number };
export const previewProxyTargetCache = new Map<string, CachedProxyTarget>();
export const PREVIEW_PROXY_CACHE_SAFETY_MS = 30_000;

export const getCachedProxyTarget = (url: string): CachedProxyTarget | null => {
  const entry = previewProxyTargetCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt - Date.now() <= PREVIEW_PROXY_CACHE_SAFETY_MS) {
    previewProxyTargetCache.delete(url);
    return null;
  }
  return entry;
};

export const getBrowserProxyTargetKey = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};
