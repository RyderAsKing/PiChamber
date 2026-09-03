/**
 * The composer's prefix-token grammar: `/skill`, `/command` and `#snippet`.
 *
 * Structurally these are the same construct — a sigil at a word boundary
 * followed by an identifier — and they were previously scanned by three
 * different regexes per sigil (highlighting, send-time collection, and the
 * autocomplete trigger), each with its own idea of the valid character set.
 * The send-time skill scanner, for instance, accepted only lowercase names, so
 * a `/My_Skill` token was painted as a command but never collected.
 *
 * Scanning is deliberately generous: it finds every syntactically plausible
 * token and leaves the decision of what exists to the caller, which holds the
 * authoritative set of commands, skills or snippets. Membership is the
 * authority; the pattern is only a locator.
 *
 * @see mentions.ts for the `@` half of the grammar.
 */

/**
 * Snippet identifiers start alphanumeric, followed by alphanumerics, `-`, or
 * `_`. Slash invocations follow Pi's broader non-whitespace command grammar,
 * including native skills (`/skill:name`), extension suffixes (`/hello:2`),
 * and prompt names derived from existing filenames (`/review.v2`). A slash
 * token still requires a start-of-text/whitespace boundary, so `a/b` stays
 * prose and `#name` remains exclusively a snippet trigger.
 */
const TOKEN_NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';
// Pi resolves slash commands with /^\/([^\s]+)/. Keep scanning aligned with
// Pi and let authoritative catalog membership reject punctuation or unknown
// names. A second slash ends the token so ordinary paths remain prose.
const SLASH_TOKEN_NAME = '[A-Za-z0-9][^\\s/]*';

/** Sigils that introduce a prefix token. */
export type TokenPrefix = '/' | '#';

export interface PrefixToken {
    /** Offset of the sigil. */
    start: number;
    /** Offset just past the identifier. */
    end: number;
    /** The sigil that introduced this token. */
    prefix: TokenPrefix;
    /** The identifier without its sigil. */
    name: string;
}

const SCANNERS: Record<TokenPrefix, RegExp> = {
    '/': new RegExp(`(^|\\s)\\/(${SLASH_TOKEN_NAME})`, 'g'),
    '#': new RegExp(`(^|\\s)#(${TOKEN_NAME})`, 'g'),
};

/**
 * Find every `prefix`-token in `text`. A token must sit at the start of the
 * text or directly after whitespace, so `a/b` and `#1` inside `issue#1` stay
 * ordinary prose.
 */
export function scanPrefixTokens(text: string, prefix: TokenPrefix): PrefixToken[] {
    if (!text || !text.includes(prefix)) return [];

    const scanner = SCANNERS[prefix];
    const tokens: PrefixToken[] = [];
    scanner.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = scanner.exec(text)) !== null) {
        const name = match[2];
        // The leading-whitespace capture keeps the boundary check inside the
        // pattern; the token itself starts after it.
        const start = match.index + match[1].length;
        tokens.push({ start, end: start + 1 + name.length, prefix, name });
    }

    return tokens;
}

/**
 * The tokens whose name is present in `known`, in document order. `compare`
 * decides how a token name is matched against the set — snippets and slash
 * invocations both match case-insensitively, while the skill-instruction
 * builder matches the exact registered name.
 */
export function filterKnownTokens(
    tokens: readonly PrefixToken[],
    known: ReadonlySet<string>,
    compare: 'exact' | 'case-insensitive' = 'case-insensitive',
): PrefixToken[] {
    if (known.size === 0) return [];
    return tokens.filter((token) => known.has(
        compare === 'exact' ? token.name : token.name.toLowerCase(),
    ));
}

/**
 * Distinct names of the known `prefix`-tokens in `text`, in first-occurrence
 * order. Used to tell the model which skills the user named explicitly.
 */
export function collectKnownTokenNames(
    text: string,
    prefix: TokenPrefix,
    known: ReadonlySet<string>,
    compare: 'exact' | 'case-insensitive' = 'case-insensitive',
): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const token of filterKnownTokens(scanPrefixTokens(text, prefix), known, compare)) {
        if (seen.has(token.name)) continue;
        seen.add(token.name);
        names.push(token.name);
    }
    return names;
}
