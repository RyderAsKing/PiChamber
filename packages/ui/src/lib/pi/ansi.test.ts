import { describe, expect, test } from "bun:test"

import { containsAnsiEscape, extractAnsiTruecolor, stripAnsi } from "./ansi"

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
