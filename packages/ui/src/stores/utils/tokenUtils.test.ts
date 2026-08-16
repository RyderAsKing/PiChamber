import { describe, expect, test } from "bun:test";

import type { PiUsageLike } from "./tokenUtils";
import { computePiContextWindowTokens, extractPiUsageBreakdown, extractSessionMessageBreakdown } from "./tokenUtils";

describe("computePiContextWindowTokens", () => {
    test("returns 0 for missing or malformed usage", () => {
        expect(computePiContextWindowTokens(null)).toBe(0);
        expect(computePiContextWindowTokens(undefined)).toBe(0);
        expect(computePiContextWindowTokens({} as PiUsageLike)).toBe(0);
    });

    test("sums input + cacheRead + cacheWrite but excludes output", () => {
        const usage = { input: 100, output: 50, cacheRead: 25, cacheWrite: 5 };
        expect(computePiContextWindowTokens(usage)).toBe(130);
    });

    test("coerces finite non-negative numbers and drops the rest", () => {
        expect(computePiContextWindowTokens({
            input: 10,
            cacheRead: Number.NaN,
            cacheWrite: -5,
        })).toBe(10);
        expect(computePiContextWindowTokens({
            input: 10,
            cacheRead: 5,
            cacheWrite: Infinity,
        })).toBe(15);
        expect(computePiContextWindowTokens({
            input: "10" as unknown as number,
            cacheRead: 5,
            cacheWrite: 0,
        })).toBe(5);
    });

    test("ignores the cost subobject entirely", () => {
        const usage = {
            input: 7,
            cacheRead: 3,
            cacheWrite: 0,
            cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        };
        expect(computePiContextWindowTokens(usage)).toBe(10);
    });
});

describe("extractPiUsageBreakdown", () => {
    test("returns null when no usage is present", () => {
        expect(extractPiUsageBreakdown(null)).toBeNull();
        expect(extractPiUsageBreakdown(undefined)).toBeNull();
    });

    test("maps Pi usage into the sidebar breakdown with reasoning = null", () => {
        const breakdown = extractPiUsageBreakdown({
            input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165,
            cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
        });
        expect(breakdown).toEqual({
            input: 100, output: 50, cacheRead: 10, cacheWrite: 5,
            reasoning: null, total: 165,
        });
    });

    test("coerces non-finite or negative values to 0", () => {
        const breakdown = extractPiUsageBreakdown({
            input: Number.NaN, output: -1, cacheRead: 5, cacheWrite: 0, totalTokens: 0,
        });
        expect(breakdown).toEqual({
            input: 0, output: 0, cacheRead: 5, cacheWrite: 0,
            reasoning: null, total: 5,
        });
    });
});

describe("extractSessionMessageBreakdown", () => {
    test("prefers Pi usage when present", () => {
        const result = extractSessionMessageBreakdown({
            info: {
                usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165 },
                tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 1, write: 1 } },
            },
            parts: [],
        });
        expect(result).toEqual({
            input: 100, output: 50, cacheRead: 10, cacheWrite: 5,
            reasoning: null, total: 165,
        });
    });

    test("falls back to info.tokens when usage is missing", () => {
        const result = extractSessionMessageBreakdown({
            info: { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } },
            parts: [],
        });
        expect(result).toEqual({
            input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5,
            total: 15,
        });
    });

    test("falls back to part tokens when info.tokens is missing and part has tokens", () => {
        const result = extractSessionMessageBreakdown({
            info: {},
            parts: [{ tokens: { input: 7, output: 1, reasoning: 0, cache: { read: 2, write: 0 } } }],
        });
        expect(result.input).toBe(7);
        expect(result.cacheRead).toBe(2);
        expect(result.total).toBe(10);
    });

    test("returns zero breakdown when no usage and no tokens are present", () => {
        const result = extractSessionMessageBreakdown({ info: {}, parts: [] });
        expect(result).toEqual({
            input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0,
        });
    });
});
