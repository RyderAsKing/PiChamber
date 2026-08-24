import { Marked, marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { parseAgentHref, parseSkillHref } from '@/lib/messages/inlineMessageLinks';
import { highlightCodeInWorker } from './markdown-worker';
import { escapeRawMarkdownHtml, MARKDOWN_FORBIDDEN_TAGS } from './markdownSecurity';
import {
  releaseStreamParser,
  streamMarkdownBlocks,
  streamParserFor,
  type MarkdownBlock,
} from './markdownStreamBlocks';

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// marked parser (HTML string output) with safe external links
// ---------------------------------------------------------------------------

// Math delimiters that use backslashes — `\(...\)` (inline) and `\[...\]`
// (display) — must be caught during lexing: marked treats `\(`/`\[` as
// backslash escapes and strips the slash before any HTML post-process can see
// them. Registering them as tokenizers also makes them code-safe for free
// (marked tokenizes code spans/fences first, so these never fire inside code).
// Single-dollar `$...$` is intentionally NOT supported — it collides with
// currency text ($50, US$ 680); only `$$...$$` survives as display math (see
// renderMathExpressions). This mirrors KaTeX auto-render's default delimiters.
type MathToken = { type: string; raw: string; text: string };

// KaTeX (259 kB) is the largest eager dependency in the chat render path.
// Load it only when math is actually present, and never during streaming's
// hot path — DeepSeek keeps Shiki/KaTeX off until the message settles.
let katexPromise: Promise<{ renderToString: (tex: string, opts: { displayMode: boolean; throwOnError: boolean }) => string }> | null = null;
const loadKatex = (): Promise<{ renderToString: (tex: string, opts: { displayMode: boolean; throwOnError: boolean }) => string }> => {
  if (!katexPromise) {
    katexPromise = import('katex').then((module) => (module as unknown as { default: { renderToString: (tex: string, opts: { displayMode: boolean; throwOnError: boolean }) => string } }).default ?? (module as unknown as { renderToString: (tex: string, opts: { displayMode: boolean; throwOnError: boolean }) => string }));
  }
  return katexPromise;
};

const renderKatex = async (math: string, raw: string, displayMode: boolean): Promise<string> => {
  try {
    const katex = await loadKatex();
    return katex.renderToString(math, { displayMode, throwOnError: false });
  } catch {
    return raw;
  }
};

const inlineMathExtension = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string) {
    const index = src.indexOf('\\(');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (!match) return undefined;
    return { type: 'inlineMath', raw: match[0], text: match[1] ?? '' };
  },
  async renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return renderKatex(math.text, math.raw, false);
  },
};

const blockMathExtension = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    const index = src.indexOf('\\[');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (!match) return undefined;
    return { type: 'blockMath', raw: match[0], text: match[1] ?? '' };
  },
  async renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return renderKatex(math.text, math.raw, true);
  },
};

const sharedRenderer = {
  // Assistant output is untrusted. Markdown constructs still render as HTML,
  // but raw HTML must remain visible text so it cannot introduce active DOM
  // such as stylesheets or positioned overlays into the application shell.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  html({ text }: any) {
    return escapeRawMarkdownHtml(text);
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  link({ href, title, text }: any) {
    const target = href ?? '';
    const agentName = parseAgentHref(target);
    if (agentName) {
      return `<span data-pichamber-agent-mention="true" class="text-primary">${text}</span>`;
    }
    const skillName = parseSkillHref(target);
    if (skillName) {
      return `<a href="${escapeAttr(target)}" data-skill-name="${escapeAttr(skillName)}" class="text-primary hover:underline">${text}</a>`;
    }
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
    return `<a href="${escapeAttr(target)}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
};

const sharedMarkedOptions = {
  gfm: true,
  breaks: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer: sharedRenderer as any,
} as const;

// Synchronous parser for the hot first-paint path — no KaTeX, no async.
// Keeps the initial chunk free of the 259 kB katex import.
const syncParser = new Marked(sharedMarkedOptions);

// Async parser for the settled path — KaTeX via dynamic import.
const asyncParser = new Marked({
  ...sharedMarkedOptions,
  async: true,
  extensions: [inlineMathExtension, blockMathExtension],
});
// Preserve legacy `marked.use` global for any external callers that rely on
// the default instance (none in-repo, but keeps `marked.parse` working).
marked.use({
  ...sharedMarkedOptions,
  extensions: [inlineMathExtension, blockMathExtension],
});

// ---------------------------------------------------------------------------
// Math (KaTeX) — post-process the parsed HTML, skipping code/pre/kbd content
// ---------------------------------------------------------------------------

// Only `$$...$$` (display) is handled here. Single-dollar `$...$` inline math is
// deliberately omitted: it parses currency text ($50, US$ 680, "$50M to $72M")
// as math and corrupts it. Inline math is supported via `\(...\)` (see the
// marked extensions above). `$$` survives marked untouched (no backslash), so
// post-processing the parsed HTML — skipping code via renderMathExpressions —
// stays correct and code-safe.
const renderMathInText = async (text: string): Promise<string> => {
  const segments = text.split(/(\$\$[\s\S]*?\$\$)/g);
  const rendered = await Promise.all(
    segments.map(async (segment) => {
      const inner = /^\$\$([\s\S]*?)\$\$$/.exec(segment)?.[1];
      if (inner === undefined) return segment;
      return renderKatex(inner, segment, true);
    }),
  );
  return rendered.join('');
};

const renderMathExpressions = async (html: string): Promise<string> => {
  // No `$` anywhere means no math to render — skip the split + regex passes on
  // the hot streaming path (the overwhelming majority of blocks have no math).
  if (html.indexOf('$') === -1) return html;

  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi;
  const parts = html.split(codeBlockPattern);
  const rendered = await Promise.all(
    parts.map(async (part, index) => (index % 2 === 1 ? part : renderMathInText(part))),
  );
  return rendered.join('');
};

// ---------------------------------------------------------------------------
// Syntax highlighting (Shiki via @pierre/diffs shared highlighter)
// ---------------------------------------------------------------------------

const CODE_BLOCK_RE = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

// Skip syntax highlighting for very large blocks — tokenizing thousands of
// lines blocks the main thread. Plain (escaped) code is shown instead.
const CODE_HIGHLIGHT_LINE_LIMIT = 1200;

const exceedsLineLimit = (value: string, limit: number): boolean => {
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10 && ++lines > limit) return true;
  }
  return false;
};

const unescapeHtml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const highlightCodeBlocks = async (html: string): Promise<string> => {
  const matches = [...html.matchAll(CODE_BLOCK_RE)];
  if (matches.length === 0) return html;

  const lineLimit = CODE_HIGHLIGHT_LINE_LIMIT;

  let result = html;
  for (const match of matches) {
    const [full, rawLang, escapedCode] = match;
    const requested = (rawLang || 'text').toLowerCase();
    // Leave mermaid fences untouched so the decorate pass can render them as
    // diagrams (highlighting would strip the `language-mermaid` class).
    if (requested === 'mermaid') continue;

    const code = unescapeHtml(escapedCode ?? '');

    // Oversized block: skip highlight, keep plain code but stamp the language.
    if (exceedsLineLimit(code, lineLimit)) {
      result = result.replace(full, () => full.replace('<pre', `<pre data-md-lang="${requested}"`));
      continue;
    }

    // Tokenize off the main thread. On failure the worker resolves to null and
    // we keep the original escaped <pre><code> (no main-thread highlight).
    const highlighted = await highlightCodeInWorker(code, requested);
    if (highlighted) {
      // Stamp the language so the decorate pass can show a header label.
      const stamped = highlighted.replace(/^<pre/, `<pre data-md-lang="${requested}"`);
      result = result.replace(full, () => stamped);
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Sanitization (DOMPurify) — allow Shiki/KaTeX/SVG output
// ---------------------------------------------------------------------------

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ['svg', 'path', 'g', 'rect', 'line', 'polygon', 'polyline', 'circle', 'ellipse', 'text', 'tspan', 'defs', 'marker'],
  ADD_ATTR: ['d', 'viewBox', 'preserveAspectRatio', 'xmlns', 'target', 'fill', 'stroke', 'stroke-width', 'transform', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'style'],
  // Defense in depth for generated/highlighter HTML after raw markdown HTML
  // has been escaped by the marked renderer above.
  FORBID_TAGS: [...MARKDOWN_FORBIDDEN_TAGS],
  FORBID_CONTENTS: [...MARKDOWN_FORBIDDEN_TAGS],
};

let sanitizeHookInstalled = false;

const ensureSanitizeHook = (): void => {
  if (sanitizeHookInstalled) return;
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return;
  sanitizeHookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    if (node.target !== '_blank') return;
    node.setAttribute('rel', 'noopener noreferrer');
  });
};

const sanitize = (html: string): string => {
  if (!DOMPurify.isSupported) return '';
  ensureSanitizeHook();
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
};


// ---------------------------------------------------------------------------
// Per-block HTML cache (LRU, mirrors the shared checksum cache)
// ---------------------------------------------------------------------------

const CACHE_MAX = 240;
const htmlCache = new Map<string, { hash: string; html: string }>();

// FNV-1a 32-bit hash of the block content.
const hash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const touch = (key: string, entry: { hash: string; html: string }): void => {
  htmlCache.delete(key);
  htmlCache.set(key, entry);
  if (htmlCache.size <= CACHE_MAX) return;
  const oldest = htmlCache.keys().next().value;
  if (oldest) htmlCache.delete(oldest);
};

const parseBlock = async (block: MarkdownBlock): Promise<string> => {
  const parsed = await (asyncParser.parse(block.src) as Promise<string>);
  // DeepSeek leaves KaTeX and Shiki off until the message settles. Cheap
  // stream blocks (`highlight: false`) skip both; the finalize pass re-parses
  // as `full` with highlighting.
  const withMath = block.highlight ? await renderMathExpressions(parsed) : parsed;
  const highlighted = block.highlight ? await highlightCodeBlocks(withMath) : withMath;
  return sanitize(highlighted);
};

/**
 * Synchronous styled render for the first paint, before the async pipeline
 * (Shiki-in-worker highlight) resolves. Produces the SAME structural HTML as
 * `renderMarkdownBlocks` minus syntax coloring — but intentionally without
 * KaTeX: the eager `katex` import (259 kB) is now behind a dynamic import on
 * the async path. Streaming keeps KaTeX off until settle (DeepSeek), and the
 * first-paint sync block shows raw delimiters for at most one frame before
 * `renderMarkdownBlocks` replaces it with rendered math. This keeps the
 * synchronous path hot and avoids pulling KaTeX into the initial chunk.
 */
export const renderMarkdownSync = (text: string): string => {
  if (!text) return '';
  const parsed = syncParser.parse(text) as string;
  return sanitize(parsed);
};

export type RenderedBlock = {
  // Stable identity across renders for per-block DOM reconciliation. Encodes
  // content + mode + highlight so any change forces that block (and only that
  // block) to re-morph; unchanged leading blocks are skipped entirely.
  id: string;
  html: string;
  mode: MarkdownBlock['mode'];
  raw: string;
};

/**
 * Render markdown into an array of per-block sanitized HTML. Streaming-aware:
 * splits into blocks, caches per-block, heals incomplete syntax. Returning
 * blocks (instead of one joined string) lets the renderer re-morph only the
 * block that changed, keeping per-step streaming cost ~O(last block).
 * While streaming, the splitter freezes settled leading blocks and re-lexes
 * only the source tail so parse work tracks the growing frontier, not the
 * whole reply. Append-only live tails skip this function entirely and write
 * the trailing text node. The live tail is not converted to HTML; Shiki and
 * KaTeX wait until the settle pass. Live prose is a paragraph-shaped text
 * node so it wraps at the chat column; unfinished fences, lists, and quotes
 * keep pre-wrap.
 */
export const renderMarkdownBlocks = async (
  text: string,
  streaming: boolean,
  cacheKey: string,
): Promise<RenderedBlock[]> => {
  if (!text) {
    if (cacheKey) releaseStreamParser(cacheKey);
    return [];
  }

  let blocks: MarkdownBlock[];
  if (streaming) {
    blocks = streamParserFor(cacheKey).update(text);
  } else {
    releaseStreamParser(cacheKey);
    blocks = streamMarkdownBlocks(text, false);
  }
  return Promise.all(
    blocks.map(async (block, index) => {
      // Live tail stays a growing text node. Parsing it to HTML every chunk is
      // quadratic in the last paragraph and is the stream hitch DeepSeek avoids
      // by keeping the unstable tail as plain React text.
      if (block.mode === 'live') {
        return { id: `live:${index}`, html: '', mode: 'live' as const, raw: block.raw };
      }
      const contentHash = hash(block.raw);
      const id = `${contentHash}:${block.mode}:${block.highlight ? 1 : 0}`;
      const key = `${cacheKey}:${index}:${block.mode}`;
      const cached = htmlCache.get(key);
      if (cached && cached.hash === contentHash) {
        touch(key, cached);
        return { id, html: cached.html, mode: block.mode, raw: block.raw };
      }
      const html = await parseBlock(block);
      touch(key, { hash: contentHash, html });
      return { id, html, mode: block.mode, raw: block.raw };
    }),
  );
};
