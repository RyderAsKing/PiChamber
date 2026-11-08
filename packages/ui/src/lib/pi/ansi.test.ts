import { describe, expect, test } from "bun:test"

import {
  containsAnsiEscape,
  extractAnsiTruecolor,
  parseAnsiSegments,
  safeHyperlink,
  stripAnsi,
  THEME_BG_COLORS,
  THEME_COLORS,
} from "./ansi"

describe("canonical theme lists", () => {
  test("pins the canonical THEME_COLORS and THEME_BG_COLORS lists in exact order", () => {
    expect(THEME_COLORS).toEqual([
      "accent",
      "border",
      "borderAccent",
      "borderMuted",
      "success",
      "error",
      "warning",
      "muted",
      "dim",
      "text",
      "thinkingText",
      "scrollbarTrack",
      "scrollbarThumb",
      "searchMatchText",
      "userMessageText",
      "customMessageText",
      "customMessageLabel",
      "toolTitle",
      "toolOutput",
      "mdHeading",
      "mdLink",
      "mdLinkUrl",
      "mdCode",
      "mdCodeBlock",
      "mdCodeBlockBorder",
      "mdQuote",
      "mdQuoteBorder",
      "mdHr",
      "mdListBullet",
      "toolDiffAdded",
      "toolDiffRemoved",
      "toolDiffContext",
      "syntaxComment",
      "syntaxKeyword",
      "syntaxFunction",
      "syntaxVariable",
      "syntaxString",
      "syntaxNumber",
      "syntaxType",
      "syntaxOperator",
      "syntaxPunctuation",
      "thinkingOff",
      "thinkingMinimal",
      "thinkingLow",
      "thinkingMedium",
      "thinkingHigh",
      "thinkingXhigh",
      "thinkingMax",
      "bashMode",
    ])

    expect(THEME_BG_COLORS).toEqual([
      "selectedBg",
      "searchMatchBg",
      "userMessageBg",
      "customMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ])
  })
})

describe("stripAnsi", () => {
  test("returns clean text unchanged", () => {
    expect(stripAnsi("mode:balance/max")).toBe("mode:balance/max")
    expect(stripAnsi("")).toBe("")
  })

  test("strips 24-bit foreground color sequences (dotfiles modes.ts pattern)", () => {
    const raw = "\u001b[38;2;244;114;182mmode:balance/max\u001b[39m"
    expect(stripAnsi(raw)).toBe("mode:balance/max")
  })

  test("strips basic SGR colors and resets", () => {
    expect(stripAnsi("\u001b[31merror\u001b[0m")).toBe("error")
    expect(stripAnsi("\u001b[1m\u001b[32mtok/s\u001b[39m\u001b[22m")).toBe("tok/s")
  })

  test("strips non-color CSI sequences (cursor movement)", () => {
    expect(stripAnsi("\u001b[2Kdone\u001b[1G")).toBe("done")
  })

  test("handles multiple escapes inside one string", () => {
    expect(stripAnsi("TPS: \u001b[36m127.1 tok/s\u001b[39m TTFT: \u001b[2m1371 ms\u001b[22m"))
      .toBe("TPS: 127.1 tok/s TTFT: 1371 ms")
  })

  test("leaves regular brackets and numbers untouched", () => {
    expect(stripAnsi("[38;2;244m without escape")).toBe("[38;2;244m without escape")
    expect(stripAnsi("array[0] = {a: 1}")).toBe("array[0] = {a: 1}")
  })
})

describe("extractAnsiTruecolor", () => {
  test("extracts rgb components from a 24-bit sequence", () => {
    // balance mode pink from modes.json (#F472B6)
    expect(extractAnsiTruecolor("\u001b[38;2;244;114;182mmode:balance/max\u001b[39m"))
      .toBe("rgb(244, 114, 182)")
  })

  test("returns undefined for plain text and non-truecolor SGR", () => {
    expect(extractAnsiTruecolor("plain status")).toBe(undefined)
    expect(extractAnsiTruecolor("\u001b[31mred\u001b[0m")).toBe(undefined)
  })

  test("uses the first truecolor when several appear", () => {
    expect(extractAnsiTruecolor("\u001b[38;2;1;2;3ma\u001b[39m\u001b[38;2;9;9;9mb\u001b[39m"))
      .toBe("rgb(1, 2, 3)")
  })
})

describe("containsAnsiEscape", () => {
  test("detects escape characters cheaply", () => {
    expect(containsAnsiEscape("\u001b[39m")).toBe(true)
    expect(containsAnsiEscape("clean")).toBe(false)
    expect(containsAnsiEscape("")).toBe(false)
  })
})

describe("parseAnsiSegments", () => {
  test("fast path returns clean text without allocating extra objects", () => {
    expect(parseAnsiSegments("simple string")).toEqual([{ text: "simple string" }])
    expect(parseAnsiSegments("")).toEqual([])
  })

  test("parses styles: bold, dim, italic, underline, strikethrough, inverse", () => {
    const raw = "\u001b[1mbold\u001b[22m \u001b[2mdim\u001b[22m \u001b[3mitalic\u001b[23m \u001b[4munderline\u001b[24m \u001b[9mstrike\u001b[29m"
    const segments = parseAnsiSegments(raw)
    expect(segments).toEqual([
      { text: "bold", bold: true },
      { text: " " },
      { text: "dim", dim: true },
      { text: " " },
      { text: "italic", italic: true },
      { text: " " },
      { text: "underline", underline: true },
      { text: " " },
      { text: "strike", strikethrough: true },
    ])
  })

  test("handles full reset \u001b[0m", () => {
    const raw = "\u001b[1m\u001b[31mboldred\u001b[0mplain"
    const segments = parseAnsiSegments(raw)
    expect(segments).toEqual([
      { text: "boldred", bold: true, fg: "var(--status-error)" },
      { text: "plain" },
    ])
  })

  test("maps basic 16 foreground and background colors to semantic variables", () => {
    const raw = "\u001b[31merror\u001b[39m \u001b[32msuccess\u001b[39m \u001b[33mwarn\u001b[39m \u001b[34minfo\u001b[39m \u001b[41mbg-err\u001b[49m"
    const segments = parseAnsiSegments(raw)
    expect(segments).toEqual([
      { text: "error", fg: "var(--status-error)" },
      { text: " " },
      { text: "success", fg: "var(--status-success)" },
      { text: " " },
      { text: "warn", fg: "var(--status-warning)" },
      { text: " " },
      { text: "info", fg: "var(--status-info)" },
      { text: " " },
      { text: "bg-err", bg: "var(--status-error-background, color-mix(in srgb, var(--status-error) 15%, transparent))" },
    ])
  })

  test("parses 256 colors (38;5;n and 48;5;n)", () => {
    // 16 is 0,0,0
    const raw = "\u001b[38;5;16mcolor16\u001b[39m \u001b[48;5;196mbg196\u001b[49m"
    const segments = parseAnsiSegments(raw)
    expect(segments).toEqual([
      { text: "color16", fg: "rgb(0, 0, 0)" },
      { text: " " },
      { text: "bg196", bg: "rgb(255, 0, 0)" },
    ])
  })

  test("parses literal truecolor (38;2;r;g;b and 48;2;r;g;b)", () => {
    const raw = "\u001b[38;2;244;114;182mpink\u001b[39m \u001b[48;2;50;60;70mbg\u001b[49m"
    const segments = parseAnsiSegments(raw)
    expect(segments).toEqual([
      { text: "pink", fg: "rgb(244, 114, 182)" },
      { text: " " },
      { text: "bg", bg: "rgb(50, 60, 70)" },
    ])
  })

  test("decodes reserved marker tuples (38;2;1;1;<index> and 48;2;1;1;<index>) to PiChamber CSS tokens", () => {
    const successIndex = THEME_COLORS.indexOf("success")
    const selectedBgIndex = THEME_BG_COLORS.indexOf("selectedBg")
    const raw = `\u001b[38;2;1;1;${successIndex}msuccessText\u001b[39m \u001b[48;2;1;1;${selectedBgIndex}mselectedBg\u001b[49m`
    const segments = parseAnsiSegments(raw)
    expect(segments).toEqual([
      { text: "successText", fg: "var(--status-success)" },
      { text: " " },
      { text: "selectedBg", bg: "var(--interactive-selection)" },
    ])
  })

  test("handles inverse formatting flag", () => {
    const raw = "\u001b[31m\u001b[42m\u001b[7minverted\u001b[27m"
    const segments = parseAnsiSegments(raw)
    expect(segments).toEqual([
      {
        text: "inverted",
        fg: "var(--status-error)",
        bg: "var(--status-success-background, color-mix(in srgb, var(--status-success) 15%, transparent))",
        inverse: true,
      },
    ])
  })

  test("strips non-SGR CSI commands and ignores malformed sequences gracefully", () => {
    const raw = "\u001b[2Kcleaned\u001b[1G \u001b[38;2;999;999;999mtext\u001b[999m done"
    const segments = parseAnsiSegments(raw)
    expect(segments.map((s) => s.text).join("")).toBe("cleaned text done")
  })

  test("strips private-mode CSI sequences without leaking sequence parameter text", () => {
    const raw = "Cursor \u001b[?25hshown, bracketed paste \u001b[?2004lenabled\u001b[?25l"
    const segments = parseAnsiSegments(raw)
    expect(segments).toEqual([
      { text: "Cursor shown, bracketed paste enabled" },
    ])

    // Private mode mixed with styled text
    const mixed = "\u001b[?25h\u001b[32mSuccess\u001b[39m\u001b[?2004l \u001b[38;2;1;1;4mThemeToken\u001b[39m"
    const mixedSegments = parseAnsiSegments(mixed)
    expect(mixedSegments).toEqual([
      { text: "Success", fg: "var(--status-success)" },
      { text: " " },
      { text: "ThemeToken", fg: "var(--status-success)" },
    ])
  })
})

describe("OSC 8 hyperlinks", () => {
  test("carry the link target on the text they wrap, with either terminator", () => {
    const st = "\x1b]8;;https://auth.example/authorize?x=1\x1b\\open\x1b]8;;\x1b\\ after"
    expect(parseAnsiSegments(st)).toEqual([
      { text: "open", href: "https://auth.example/authorize?x=1" },
      { text: " after" },
    ])
    const bel = "\x1b]8;id=a;https://x.example/\x07link\x1b]8;;\x07"
    expect(parseAnsiSegments(bel)).toEqual([{ text: "link", href: "https://x.example/" }])
  })

  test("survive SGR resets inside the link, as in a terminal", () => {
    const text = "\x1b]8;;https://x.example/\x07\x1b[36mab\x1b[0mcd\x1b]8;;\x07"
    expect(parseAnsiSegments(text)).toEqual([
      { text: "ab", fg: "var(--status-info)", href: "https://x.example/" },
      { text: "cd", href: "https://x.example/" },
    ])
  })

  test("only http and https targets are linkable", () => {
    expect(safeHyperlink("https://x.example/a b")).toBe("https://x.example/a%20b")
    expect(safeHyperlink("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/")
    expect(safeHyperlink("javascript:alert(1)")).toBeUndefined()
    expect(safeHyperlink("file:///etc/passwd")).toBeUndefined()
    expect(safeHyperlink("not a url")).toBeUndefined()
    expect(safeHyperlink(undefined)).toBeUndefined()
  })
})
