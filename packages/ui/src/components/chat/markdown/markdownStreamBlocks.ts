import { marked, type Tokens } from 'marked';
import remend from 'remend';

export type MarkdownBlock = {
  raw: string;
  src: string;
  mode: 'full' | 'live';
  // When false, skip syntax highlighting for this block. While a message
  // streams, every block stays unhighlighted (DeepSeek: Shiki/KaTeX wait for
  // settle). Highlighting lands on the finalize `full` parse.
  highlight: boolean;
};

export type MarkdownLexer = (text: string) => Tokens.Generic[];

const defaultMarkdownLexer: MarkdownLexer = (text) => marked.lexer(text) as Tokens.Generic[];

const hasReferenceDefinitions = (text: string): boolean =>
  /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text);

export const hasOpenFence = (raw: string): boolean => {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return false;
  const mark = match[1];
  if (!mark) return false;
  const char = mark[0];
  const size = mark.length;
  const last = raw.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
};

/** Live tails that must keep source newlines (fences, lists, quotes). Prose uses normal wrap. */
export const isPreformattedLiveMarkdown = (raw: string): boolean => {
  const start = raw.replace(/^\n+/, '');
  if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(start)) return true;
  if (/^[ \t]{0,3}(?:> |[-*+] |\d+[.)] )/.test(start)) return true;
  return false;
};

const heal = (text: string): string => {
  try {
    return remend(text, { linkMode: 'text-only' });
  } catch {
    return text;
  }
};

const fallbackBlock = (text: string, live: boolean): MarkdownBlock[] => (
  [{ raw: text, src: text, mode: live ? 'live' : 'full', highlight: !live }]
);

type SplitOptions = {
  markLastLive: boolean;
  // DeepSeek keeps Shiki/KaTeX off for the whole in-flight message. Frozen
  // stream blocks stay unhighlighted until the settle pass re-parses as `full`.
  cheap: boolean;
};

const tokensToBlocks = (
  tokens: readonly Tokens.Generic[],
  options: SplitOptions,
): MarkdownBlock[] => {
  let tail = -1;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i]?.type !== 'space') {
      tail = i;
      break;
    }
  }
  if (tail < 0) return [];

  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.type === 'space') continue;
    const raw = token.raw ?? '';
    const isLast = options.markLastLive && i === tail;
    const openFence = token.type === 'code' && hasOpenFence(raw);
    blocks.push({
      raw,
      src: openFence || isLast ? raw : heal(raw),
      mode: isLast ? 'live' : 'full',
      highlight: !options.cheap && !openFence,
    });
  }
  return blocks;
};

/**
 * Split markdown into render blocks. When not streaming, returns a single
 * `full` block. While streaming, heals incomplete syntax and isolates an
 * unclosed trailing code fence into its own `live` block so a partial fence
 * does not corrupt the parse of stable content above it.
 */
export const streamMarkdownBlocks = (
  text: string,
  live: boolean,
  lex: MarkdownLexer = defaultMarkdownLexer,
): MarkdownBlock[] => {
  if (!live) return [{ raw: text, src: text, mode: 'full', highlight: true }];
  // Reference-style links/footnotes span multiple tokens (definition elsewhere);
  // keep them as a single block so per-block parsing doesn't break the refs.
  if (hasReferenceDefinitions(text)) {
    return fallbackBlock(text, true);
  }

  let tokens: Tokens.Generic[];
  try {
    tokens = lex(text);
  } catch {
    return fallbackBlock(text, true);
  }

  const blocks = tokensToBlocks(tokens, { markLastLive: true, cheap: true });
  return blocks.length === 0 ? fallbackBlock(text, true) : blocks;
};

const UNSTABLE_TAIL_BLOCKS = 2;

/**
 * Incremental streaming splitter. Re-lexing the whole accumulated reply on
 * every chunk is quadratic in final length. CommonMark block parsing is
 * line-based, so appended text can only reshape the last couple of top-level
 * blocks; earlier blocks freeze and later chunks parse only the source tail.
 */
export class IncrementalMarkdownStream {
  private prevText = '';
  private frozenSrc = '';
  private frozenBlocks: MarkdownBlock[] = [];
  private cached: MarkdownBlock[] | null = null;

  constructor(private readonly lex: MarkdownLexer = defaultMarkdownLexer) {}

  update(text: string): MarkdownBlock[] {
    if (this.cached && text === this.prevText) return this.cached;
    if (this.prevText && !text.startsWith(this.prevText)) {
      this.frozenSrc = '';
      this.frozenBlocks = [];
    }
    this.prevText = text;
    if (hasReferenceDefinitions(text)) {
      this.frozenSrc = '';
      this.frozenBlocks = [];
      this.cached = fallbackBlock(text, true);
      return this.cached;
    }
    if (this.frozenSrc && !text.startsWith(this.frozenSrc)) {
      this.frozenSrc = '';
      this.frozenBlocks = [];
    }

    const tail = text.slice(this.frozenSrc.length);
    let tokens: Tokens.Generic[];
    try {
      tokens = this.lex(tail);
    } catch {
      this.cached = fallbackBlock(text, true);
      return this.cached;
    }

    const nonSpaceIndexes: number[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.type !== 'space') nonSpaceIndexes.push(index);
    }
    const freezeCount = Math.max(0, nonSpaceIndexes.length - UNSTABLE_TAIL_BLOCKS);
    if (freezeCount > 0) {
      const cutExclusive = (nonSpaceIndexes[freezeCount - 1] ?? -1) + 1;
      const frozenTokens = tokens.slice(0, cutExclusive);
      const newlyFrozen = tokensToBlocks(frozenTokens, { markLastLive: false, cheap: true });
      this.frozenBlocks = [...this.frozenBlocks, ...newlyFrozen];
      this.frozenSrc += frozenTokens.map((token) => token.raw ?? '').join('');
      tokens = tokens.slice(cutExclusive);
    }

    const liveBlocks = tokensToBlocks(tokens, { markLastLive: true, cheap: true });
    const next = liveBlocks.length > 0
      ? [...this.frozenBlocks, ...liveBlocks]
      : (this.frozenBlocks.length > 0 ? this.frozenBlocks : fallbackBlock(text, true));
    this.cached = next;
    return next;
  }
}

const STREAM_PARSER_CACHE_MAX = 32;
const streamParserCache = new Map<string, IncrementalMarkdownStream>();

export const streamParserFor = (cacheKey: string): IncrementalMarkdownStream => {
  const existing = streamParserCache.get(cacheKey);
  if (existing) {
    streamParserCache.delete(cacheKey);
    streamParserCache.set(cacheKey, existing);
    return existing;
  }
  const parser = new IncrementalMarkdownStream();
  streamParserCache.set(cacheKey, parser);
  while (streamParserCache.size > STREAM_PARSER_CACHE_MAX) {
    const oldest = streamParserCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    streamParserCache.delete(oldest);
  }
  return parser;
};

export const releaseStreamParser = (cacheKey: string): void => {
  streamParserCache.delete(cacheKey);
};

/** True when only the live tail raw changed; frozen leading blocks are identical. */
export const isLiveMarkdownTailAppend = (
  previous: readonly { mode: MarkdownBlock['mode']; raw: string }[] | null | undefined,
  next: readonly MarkdownBlock[],
): boolean => {
  if (!previous || previous.length === 0 || previous.length !== next.length) return false;
  const last = next[next.length - 1];
  if (last?.mode !== 'live' || previous[previous.length - 1]?.mode !== 'live') return false;
  for (let index = 0; index < next.length - 1; index += 1) {
    const prevBlock = previous[index];
    const nextBlock = next[index];
    if (!prevBlock || !nextBlock) return false;
    if (prevBlock.mode !== 'full' || nextBlock.mode !== 'full') return false;
    if (prevBlock.raw !== nextBlock.raw) return false;
  }
  return true;
};
