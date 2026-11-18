/**
 * Builds the `srcdoc` for a Visuals page.
 *
 * The page runs in a frame sandboxed with `allow-scripts` only: an opaque
 * origin with no access to PiChamber, its storage, or its cookies. On top of
 * that the document starts with a Content-Security-Policy that blocks every
 * network request unless the user allowed network in the plugin's settings.
 * A later CSP in the page can only add restrictions, never lift these.
 *
 * A page's own CSP cannot stop it navigating its frame away (`location`,
 * `<meta http-equiv="refresh">`), which would load a remote page and carry
 * data out in the URL. So the page sits in an inner frame, inside an outer
 * sandboxed document whose `frame-src 'none'` blocks that navigation while
 * network is off. The outer document only lays out the inner frame and
 * relays its messages to the app.
 */

export const VISUAL_MESSAGE_KEY = '__pichamberVisual';

/** Theme values handed to the page as CSS variables. */
export interface VisualTheme {
  colorScheme: 'light' | 'dark';
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
  font: string;
  mono: string;
  /** Data series colours, from the theme's chart palette. */
  series: [string, string, string, string, string];
  good: string;
  warn: string;
  bad: string;
}

interface VisualDocumentOptions {
  html: string;
  theme: VisualTheme;
  allowNetwork: boolean;
}

const OFFLINE_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data:",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const ONLINE_POLICY = [
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export const visualContentSecurityPolicy = (allowNetwork: boolean): string => (
  allowNetwork ? ONLINE_POLICY : OFFLINE_POLICY
);

/** Strips characters that could end a CSS declaration from a theme value. */
const cssValue = (value: string): string => value.replace(/[;{}<>]/g, '').trim();

/** Shades of the first series colour for ordered values, strongest first, mixed toward the background. */
const SERIES_SHADES = [100, 72, 48, 28];

const themeVariables = (theme: VisualTheme): string => {
  const values: Record<string, string> = {
    bg: theme.bg, surface: theme.surface, fg: theme.fg, muted: theme.muted, border: theme.border,
    accent: theme.accent, font: theme.font, mono: theme.mono,
    good: theme.good, warn: theme.warn, bad: theme.bad, radius: '10px',
  };
  theme.series.forEach((color, index) => { values[`c${index + 1}`] = color; });
  SERIES_SHADES.forEach((share, index) => {
    values[`shade-${index + 1}`] = share === 100
      ? 'var(--pc-c1)'
      : `color-mix(in oklab, var(--pc-c1) ${share}%, var(--pc-bg))`;
  });
  return Object.entries(values).map(([name, value]) => `--pc-${name}:${cssValue(value)}`).join(';');
};

/**
 * Zero-specificity defaults (`:where`), so any rule in the page wins. They
 * make plain markup look at home in the chat: the page has no background of
 * its own, so it sits right on the chat (and any wallpaper behind it), with an 8px gutter (room for focus rings and shadows), text
 * stays at the chat's sizes, and SVG labels come out small and muted unless
 * the page colours them. The agent adds only layout.
 */
const BASE_STYLE = [
  ':where(html){background:transparent;padding:8px;scrollbar-width:none}',
  'html::-webkit-scrollbar{display:none}',
  ':where(body){margin:0;font-family:var(--pc-font);color:var(--pc-fg);font-size:14px;line-height:1.55;'
    + '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
  ':where(*,*::before,*::after){box-sizing:border-box}',
  ':where(h1,h2,h3,h4){margin:0 0 .5em;line-height:1.3;font-weight:600;text-wrap:balance}',
  ':where(h1){font-size:16px}:where(h2){font-size:15px}:where(h3){font-size:14px}:where(h4){font-size:13px;color:var(--pc-muted)}',
  ':where(p){margin:0 0 .75em;text-wrap:pretty}:where(small,figcaption,caption,legend){color:var(--pc-muted);font-size:12px}',
  ':where(a){color:var(--pc-accent);text-underline-offset:2px}',
  ':where(hr){border:0;border-top:1px solid var(--pc-border);margin:16px 0}',
  ':where(code,pre,kbd,samp){font-family:var(--pc-mono);font-size:12.5px}',
  ':where(pre){background:var(--pc-surface);border:1px solid var(--pc-border);border-radius:8px;padding:12px;overflow:auto}',
  ':where(:not(pre)>code){background:var(--pc-surface);border-radius:4px;padding:1px 4px}',
  ':where(table){border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}',
  ':where(th){text-align:left;font-weight:500;color:var(--pc-muted);font-size:12px}',
  ':where(th,td){padding:8px 10px;border-bottom:1px solid var(--pc-border);vertical-align:top}',
  ':where(button,input,select,textarea){font:inherit;color:inherit}',
  ':where(button){background:var(--pc-surface);border:1px solid var(--pc-border);border-radius:8px;padding:6px 12px;cursor:pointer}',
  ':where(button:hover){border-color:var(--pc-muted)}',
  ':where(input,select,textarea){background:var(--pc-bg);border:1px solid var(--pc-border);border-radius:8px;padding:6px 10px}',
  ':where(input[type=range],input[type=checkbox],input[type=radio]){accent-color:var(--pc-accent)}',
  // Inherited, so a font-size or fill set on the text, its group, or by a
  // page rule still wins. Shapes with no fill of their own get the muted
  // colour instead of black. Skipped where the svg sets its own (an icon's
  // fill="none"): a page rule would beat the attribute.
  ':where(svg){overflow:visible;font-family:var(--pc-font);font-variant-numeric:tabular-nums}',
  ':where(svg:not([fill])){fill:var(--pc-muted)}:where(svg:not([font-size])){font-size:12px}',
].join('');

const themeStyle = (theme: VisualTheme): string => (
  `:root{color-scheme:${theme.colorScheme};${themeVariables(theme)}}${BASE_STYLE}`
);

/**
 * Reports the content height to the host so the frame fits its page (the
 * root's own box, so a page shorter than the frame can still shrink it), and
 * hands link clicks to the host instead of navigating the frame away.
 */
const hostBridge = `(function(){
var K=${JSON.stringify(VISUAL_MESSAGE_KEY)};var last=-1;
function post(m){m[K]=true;try{parent.postMessage(m,'*')}catch(e){}}
function report(){var d=document.documentElement;if(!d)return;
var h=d.getBoundingClientRect().height;
if(d.scrollHeight>innerHeight)h=Math.max(h,d.scrollHeight);
h=Math.ceil(h);if(h!==last){last=h;post({type:'height',height:h})}}
addEventListener('load',report);
if(typeof ResizeObserver==='function'){var ro=new ResizeObserver(report);
document.addEventListener('DOMContentLoaded',function(){ro.observe(document.documentElement);if(document.body)ro.observe(document.body);report()})}
else{setInterval(report,500)}
document.addEventListener('click',function(e){var t=e.target;
while(t&&t.nodeType===1&&t.tagName!=='A')t=t.parentNode;
if(!t||t.nodeType!==1)return;var href=t.getAttribute('href')||'';
if(!href||href.charAt(0)==='#')return;e.preventDefault();
var url;try{url=new URL(href,'https://invalid.local/').href}catch(x){return}
if(/^https?:/i.test(url)&&url.indexOf('https://invalid.local/')!==0)post({type:'open',url:url})},true);
})();`;

const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i;

/**
 * The page itself. Our head comes first so its policy applies before any of
 * the page's own markup; the page's doctype is dropped and replaced with
 * ours so the page still renders in standards mode.
 */
const buildPageDocument = ({ html, theme, allowNetwork }: VisualDocumentOptions): string => {
  const body = html.replace(DOCTYPE_RE, '');
  return '<!doctype html>'
    + `<meta http-equiv="Content-Security-Policy" content="${visualContentSecurityPolicy(allowNetwork)}">`
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<style>${themeStyle(theme)}</style>`
    + `<script>${hostBridge}</script>`
    + body;
};

/** The outer document: blocks the inner frame's navigation while network is off. */
export const visualOuterPolicy = (allowNetwork: boolean): string => [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  allowNetwork ? 'frame-src * data: blob:' : "frame-src 'none'",
].join('; ');

/** Forwards the inner page's own messages, and nothing else, to the app. */
const outerRelay = `(function(){
var K=${JSON.stringify(VISUAL_MESSAGE_KEY)};var f=document.getElementById('p');
addEventListener('message',function(e){if(!f||e.source!==f.contentWindow)return;
var d=e.data;if(!d||typeof d!=='object'||d[K]!==true)return;try{parent.postMessage(d,'*')}catch(x){}});
})();`;

const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The `srcdoc` for the app's frame: the outer document holding the page. */
export const buildVisualDocument = (options: VisualDocumentOptions): string => (
  '<!doctype html>'
    + `<meta http-equiv="Content-Security-Policy" content="${visualOuterPolicy(options.allowNetwork)}">`
    + '<meta charset="utf-8">'
    + `<style>:root{color-scheme:${options.theme.colorScheme}}html,body{margin:0;height:100%;overflow:hidden;background:transparent}`
    + 'iframe{display:block;border:0;width:100%;height:100%}</style>'
    + `<iframe id="p" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(buildPageDocument(options))}"></iframe>`
    + `<script>${outerRelay}</script>`
);

/** Reads the app's current theme from its CSS variables. */
export const readVisualTheme = (root: HTMLElement, colorScheme: 'light' | 'dark'): VisualTheme => {
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    colorScheme,
    bg: read('--background', colorScheme === 'dark' ? '#111' : '#fff'),
    surface: read('--surface-elevated', colorScheme === 'dark' ? '#1a1a1a' : '#f6f6f6'),
    fg: read('--foreground', colorScheme === 'dark' ? '#eee' : '#111'),
    muted: read('--muted-foreground', '#888'),
    border: read('--interactive-border', colorScheme === 'dark' ? '#333' : '#ddd'),
    accent: read('--primary-base', '#3b82f6'),
    font: read('--font-sans', 'system-ui, sans-serif'),
    mono: read('--font-mono', 'ui-monospace, monospace'),
    series: [
      read('--chart-1', '#3b82f6'),
      read('--chart-2', '#10b981'),
      read('--chart-3', '#f59e0b'),
      read('--chart-4', '#8b5cf6'),
      read('--chart-5', '#ef4444'),
    ],
    good: read('--status-success', '#16a34a'),
    warn: read('--status-warning', '#d97706'),
    bad: read('--status-error', '#dc2626'),
  };
};

export interface VisualDetails {
  title: string;
  html: string;
  height?: number;
}

/** The `render_html` result details, or `null` when the shape is not ours. */
export const parseVisualDetails = (metadata: unknown): VisualDetails | null => {
  if (!metadata || typeof metadata !== 'object') return null;
  const record = metadata as Record<string, unknown>;
  if (typeof record.html !== 'string' || record.html.length === 0) return null;
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : 'Untitled page';
  const height = typeof record.height === 'number' && Number.isFinite(record.height) ? record.height : undefined;
  return { title, html: record.html, ...(height !== undefined ? { height } : {}) };
};

/** A file name for Download, from the page title. */
export const visualFileName = (title: string): string => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'page'}.html`;
};

const OPEN_INTERVAL_MS = 1_000;

/**
 * Whether a page's link message may open a window: the click that sent it
 * focused the page's frame and still counts as a user action (when the
 * browser can tell), and the last open was at least a second ago.
 */
export const canOpenLink = ({ frameFocused, userActive, now, lastOpenAt }: {
  frameFocused: boolean;
  /** `navigator.userActivation.isActive`; undefined where unsupported. */
  userActive: boolean | undefined;
  now: number;
  lastOpenAt: number;
}): boolean => frameFocused && userActive !== false && now - lastOpenAt >= OPEN_INTERVAL_MS;
