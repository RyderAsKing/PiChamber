import { describe, expect, test } from "bun:test"
import {
  buildAttachmentPromptLine,
  bytesToBase64,
  formatSize,
  isHeicMime,
  normalizeAttachmentMime,
  rewriteDataUrlMime,
  sanitizeFilename,
  shouldNormalizeToTextPlain,
  validateAttachmentUpload,
} from "./attachments"

describe("sanitizeFilename", () => {
  test("strips path separators", () => {
    // `..` becomes `_`, `/` becomes `_`, so `../../etc/passwd` → `____etc_passwd`.
    expect(sanitizeFilename("../../etc/passwd")).toBe("____etc_passwd")
    expect(sanitizeFilename("C:\\Users\\test\\file.txt")).toBe("C:_Users_test_file.txt")
  })

  test("replaces control characters", () => {
    expect(sanitizeFilename("file\u0000name.txt")).toBe("filename.txt")
    expect(sanitizeFilename("hello\u0007world")).toBe("helloworld")
  })

  test("falls back when empty", () => {
    expect(sanitizeFilename("")).toBe("attachment")
    // Three dots collapse to `_` then to `attachment` after the leading-dot strip.
    expect(sanitizeFilename("...")).toBe("_")
    expect(sanitizeFilename("\u0000\u0000")).toBe("attachment")
  })

  test("truncates excessively long names", () => {
    const long = "a".repeat(500)
    expect(sanitizeFilename(long).length).toBe(200)
  })
})

describe("shouldNormalizeToTextPlain", () => {
  test("flags text-like mimes", () => {
    expect(shouldNormalizeToTextPlain("text/markdown")).toBe(true)
    expect(shouldNormalizeToTextPlain("text/plain")).toBe(false)
    expect(shouldNormalizeToTextPlain("application/json")).toBe(true)
    expect(shouldNormalizeToTextPlain("application/yaml")).toBe(true)
    expect(shouldNormalizeToTextPlain("image/svg+xml")).toBe(true)
    expect(shouldNormalizeToTextPlain("image/png")).toBe(false)
  })
})

describe("isHeicMime", () => {
  test("matches HEIC/HEIF only", () => {
    expect(isHeicMime("image/heic")).toBe(true)
    expect(isHeicMime("image/heif")).toBe(true)
    expect(isHeicMime("image/HEIC")).toBe(true)
    expect(isHeicMime("image/jpeg")).toBe(false)
  })
})

describe("normalizeAttachmentMime", () => {
  test("passes through HEIC untouched (server converts)", () => {
    expect(normalizeAttachmentMime("image/heic")).toBe("image/heic")
  })

  test("converts text-like mimes to text/plain", () => {
    expect(normalizeAttachmentMime("text/markdown")).toBe("text/plain")
    expect(normalizeAttachmentMime("application/json")).toBe("text/plain")
  })

  test("preserves image mimes", () => {
    expect(normalizeAttachmentMime("image/png")).toBe("image/png")
  })

  test("defaults to octet-stream when empty", () => {
    expect(normalizeAttachmentMime("")).toBe("application/octet-stream")
  })
})

describe("rewriteDataUrlMime", () => {
  test("replaces the mime in a data URL", () => {
    const before = "data:text/markdown;base64,SGk="
    const after = rewriteDataUrlMime(before, "text/plain")
    expect(after).toBe("data:text/plain;base64,SGk=")
  })

  test("preserves the base64 marker", () => {
    const before = "data:application/json,{}"
    const after = rewriteDataUrlMime(before, "text/plain")
    expect(after).toBe("data:text/plain,{}")
  })

  test("returns the input unchanged when no comma is present", () => {
    expect(rewriteDataUrlMime("data:base64", "text/plain")).toBe("data:base64")
  })
})

describe("bytesToBase64", () => {
  test("encodes the byte sequence", () => {
    const bytes = new Uint8Array([72, 105, 33])
    expect(bytesToBase64(bytes)).toBe("SGkh")
  })
})

describe("buildAttachmentPromptLine", () => {
  test("produces a deterministic one-line summary", () => {
    const line = buildAttachmentPromptLine({
      filename: "report.pdf",
      mime: "application/pdf",
      size: 1024,
      attachmentId: "abc",
    })
    expect(line).toBe("[attachment report.pdf (application/pdf, 1.0 KB, id=abc)]")
  })
})

describe("formatSize", () => {
  test("formats byte sizes", () => {
    expect(formatSize(0)).toBe("0 B")
    expect(formatSize(512)).toBe("512 B")
    expect(formatSize(2048)).toBe("2.0 KB")
    expect(formatSize(1024 * 1024 * 5)).toBe("5.0 MB")
  })
})

describe("validateAttachmentUpload", () => {
  test("accepts reasonable files", () => {
    expect(
      validateAttachmentUpload({ mime: "image/png", filename: "photo.png", size: 4096 }),
    ).toEqual({ ok: true })
  })

  test("rejects empty payloads", () => {
    expect(
      validateAttachmentUpload({ mime: "image/png", filename: "photo.png", size: 0 }),
    ).toEqual({ ok: false, reason: "empty", message: "Attachment is empty" })
  })

  test("rejects oversized payloads", () => {
    expect(
      validateAttachmentUpload({
        mime: "image/png",
        filename: "huge.png",
        size: 200 * 1024 * 1024,
      }),
    ).toEqual({ ok: false, reason: "too-large", message: "Attachment exceeds the 100 MB limit" })
  })

  test("rejects executable mimes", () => {
    expect(
      validateAttachmentUpload({
        mime: "application/x-msdownload",
        filename: "evil.exe",
        size: 1024,
      }),
    ).toEqual({ ok: false, reason: "invalid-mime", message: "Refusing to upload application/x-msdownload" })
  })
})
