import type { Message, Part } from "@opencode-ai/sdk/v2";

type TokenBreakdown = {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
        read?: number;
        write?: number;
    };
};

export const sumTokenBreakdown = (breakdown: TokenBreakdown | null | undefined): number => {
    if (!breakdown || typeof breakdown !== 'object') {
        return 0;
    }

    const inputTokens = breakdown.input ?? 0;
    const outputTokens = breakdown.output ?? 0;
    const reasoningTokens = breakdown.reasoning ?? 0;
    const cacheReadTokens = breakdown.cache && typeof breakdown.cache === 'object' ? breakdown.cache.read ?? 0 : 0;
    const cacheWriteTokens = breakdown.cache && typeof breakdown.cache === 'object' ? breakdown.cache.write ?? 0 : 0;

    return inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
};

export const extractTokensFromMessage = (message: { info: Message; parts: Part[] }): number => {
    const tokens = (message.info as { tokens?: number | TokenBreakdown }).tokens;

    if (typeof tokens === 'number') {
        return tokens;
    }

    if (tokens && typeof tokens === 'object') {
        return sumTokenBreakdown(tokens);
    }

    const tokenPart = message.parts.find(
        (part) => typeof (part as { tokens?: number | TokenBreakdown }).tokens !== 'undefined'
    ) as { tokens?: number | TokenBreakdown } | undefined;

    if (!tokenPart || typeof tokenPart.tokens === 'undefined') {
        return 0;
    }

    if (typeof tokenPart.tokens === 'number') {
        return tokenPart.tokens;
    }

    return sumTokenBreakdown(tokenPart.tokens);
};

type CacheHitRateResult = {
    /** Cache hit rate as a 0-100 percentage. 0 when there is no input to compare against. */
    percent: number;
    /** True iff `breakdown` had a positive inclusive input total. When false, `percent` is meaningless. */
    hasInput: boolean;
};

/**
 * Compute prefix-cache hit rate from a token breakdown.
 *
 * The SDK reports `input` as the non-cached portion (total input minus
 * cache reads and cache writes). The full input processed by the model is
 * therefore:
 *
 *   totalInput = input + cache.read + cache.write
 *
 *   cacheHitRate = cache.read / totalInput
 *
 * Verified against the SDK source (`session.ts:getUsage`): `input` 
 * is `safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)`.
 *
 * Returns `hasInput: false` when there is no total input to compare against,
 * in which case `percent` is 0 and callers should hide the display.
 */
export const computeCacheHitRate = (breakdown: TokenBreakdown | null | undefined): CacheHitRateResult => {
    if (!breakdown || typeof breakdown !== 'object') {
        return { percent: 0, hasInput: false };
    }

    const input = breakdown.input ?? 0;
    const cacheRead = breakdown.cache && typeof breakdown.cache === 'object' ? breakdown.cache.read ?? 0 : 0;
    const cacheWrite = breakdown.cache && typeof breakdown.cache === 'object' ? breakdown.cache.write ?? 0 : 0;
    const total = input + cacheRead + cacheWrite;

    if (total <= 0) {
        return { percent: 0, hasInput: false };
    }

    const safeRead = Math.max(0, cacheRead);
    const percent = Math.min(100, Math.max(0, (safeRead / total) * 100));
    return { percent, hasInput: true };
};

/**
 * Pi-native usage shape, mirrored from
 * `packages/ui/src/lib/pi/types.ts` so the sidebar can read it without
 * importing the Pi runtime module. The daemon sanitizes every field to a
 * finite, non-negative number before publication, so the adapter does not
 * re-validate.
 */
export interface PiUsageLike {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
    };
}

/**
 * Pi public shortcut for the context bar denominator. The "tokens in the
 * window" excludes the per-turn output (which is what the model just
 * produced) and matches how Pi providers surface the budget they consumed.
 */
export const computePiContextWindowTokens = (usage: PiUsageLike | null | undefined): number => {
    if (!usage || typeof usage !== 'object') return 0;
    const input = typeof usage.input === 'number' && Number.isFinite(usage.input) && usage.input >= 0 ? usage.input : 0;
    const cacheRead = typeof usage.cacheRead === 'number' && Number.isFinite(usage.cacheRead) && usage.cacheRead >= 0 ? usage.cacheRead : 0;
    const cacheWrite = typeof usage.cacheWrite === 'number' && Number.isFinite(usage.cacheWrite) && usage.cacheWrite >= 0 ? usage.cacheWrite : 0;
    return input + cacheRead + cacheWrite;
};

/**
 * Detailed per-row token breakdown used by the context sidebar. Pi has no
 * separate reasoning-token field, so when `info.usage` is present the
 * `reasoning` slot is `null` to render the `—` glyph exactly as the spec
 * requires. The OpenCode-style fallback path keeps `reasoning` numeric.
 */
export interface DetailedTokenBreakdown {
    input: number;
    output: number;
    reasoning: number | null;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

const NON_NEGATIVE = (value: unknown): number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
);

/**
 * Convert a PiChamber `info.usage` payload into the sidebar's detailed
 * breakdown. Returns `null` when no usage is present so the caller can fall
 * back to the legacy OpenCode-style extraction.
 */
export const extractPiUsageBreakdown = (usage: PiUsageLike | null | undefined): DetailedTokenBreakdown | null => {
    if (!usage || typeof usage !== "object") return null;
    const input = NON_NEGATIVE(usage.input);
    const output = NON_NEGATIVE(usage.output);
    const cacheRead = NON_NEGATIVE(usage.cacheRead);
    const cacheWrite = NON_NEGATIVE(usage.cacheWrite);
    return {
        input,
        output,
        reasoning: null,
        cacheRead,
        cacheWrite,
        total: input + output + cacheRead + cacheWrite,
    };
};

/**
 * Sidebar-style breakdown of a session message. Prefers Pi `info.usage` (the
 * PiChamber protocol contract) and falls back to the legacy OpenCode
 * `info.tokens` / per-part `tokens` extraction when usage is absent (older
 * daemon builds or sessions that pre-date the usage upgrade).
 */
export const extractSessionMessageBreakdown = (message: { info: { usage?: PiUsageLike; tokens?: unknown } & Record<string, unknown>; parts: Array<{ tokens?: unknown } & Record<string, unknown>> }): DetailedTokenBreakdown => {
    const pi = extractPiUsageBreakdown(message.info.usage);
    if (pi) return pi;

    const tokenCandidate = (message.info as { tokens?: unknown }).tokens;
    const source = tokenCandidate !== undefined
        ? tokenCandidate
        : message.parts.find((part) => (part as { tokens?: unknown }).tokens !== undefined)?.tokens;

    if (typeof source === "number") {
        return {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: NON_NEGATIVE(source),
        };
    }

    if (!source || typeof source !== "object") {
        return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    }

    const breakdown = source as {
        input?: unknown;
        output?: unknown;
        reasoning?: unknown;
        cache?: { read?: unknown; write?: unknown };
    };

    const input = NON_NEGATIVE(breakdown.input);
    const output = NON_NEGATIVE(breakdown.output);
    const reasoning = NON_NEGATIVE(breakdown.reasoning);
    const cacheRead = NON_NEGATIVE(breakdown.cache?.read);
    const cacheWrite = NON_NEGATIVE(breakdown.cache?.write);

    return {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total: input + output + reasoning + cacheRead + cacheWrite,
    };
};
