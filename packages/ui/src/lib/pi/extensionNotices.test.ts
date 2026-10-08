import { beforeEach, describe, expect, test } from "bun:test"
import {
  EXTENSION_NOTICES_SEEN_KEY,
  type ExtensionNoticesSeenMap,
  formatExtensionNoticeTime,
  getExtensionNoticesSeenAt,
  markExtensionNoticesSeen,
  MAX_EXTENSION_NOTICES_SEEN_ENTRIES,
  newestExtensionNoticeAt,
  readExtensionNoticesSeen,
  selectUnreadExtensionNotices,
  shouldToastExtensionNotice,
  STALE_LIVE_NOTICE_TOAST_GUARD_MS,
  subscribeExtensionNoticesSeen,
} from "./extensionNotices"
import type { PiReducerExtensionNotice } from "./reducers/reducerTypes"
import { getSafeStorage } from "@/stores/utils/safeStorage"

const notice = (
  id: string,
  createdAt: number,
  origin: PiReducerExtensionNotice["origin"] = "live",
  serverTimestamp = true,
  toastAgeBase?: number,
): PiReducerExtensionNotice => ({
  id,
  message: `message ${id}`,
  level: "info",
  createdAt,
  origin,
  serverTimestamp,
  ...(toastAgeBase !== undefined ? { toastAgeBase } : {}),
})

describe("extension notice seen markers", () => {
  beforeEach(() => {
    try {
      getSafeStorage().removeItem(EXTENSION_NOTICES_SEEN_KEY)
    } catch {
      // No storage in this environment; helpers already tolerate that.
    }
  })

  test("empty storage reads as no seen timestamp", () => {
    expect(readExtensionNoticesSeen()).toEqual({})
    expect(getExtensionNoticesSeenAt({}, "local", "sess-1")).toBeUndefined()
  })

  test("malformed storage reads as empty and never throws", () => {
    getSafeStorage().setItem(EXTENSION_NOTICES_SEEN_KEY, "not-json{{{")
    expect(readExtensionNoticesSeen()).toEqual({})
    getSafeStorage().setItem(EXTENSION_NOTICES_SEEN_KEY, JSON.stringify({ ok: "nope", n: -5 }))
    expect(readExtensionNoticesSeen()).toEqual({})
  })

  test("marking seen records the newest createdAt per runtime and session", () => {
    markExtensionNoticesSeen("local", "sess-1", 1000)
    markExtensionNoticesSeen("local", "sess-2", 2000)
    markExtensionNoticesSeen("remote", "sess-1", 3000)
    const seen: ExtensionNoticesSeenMap = readExtensionNoticesSeen()
    expect(getExtensionNoticesSeenAt(seen, "local", "sess-1")).toBe(1000)
    expect(getExtensionNoticesSeenAt(seen, "local", "sess-2")).toBe(2000)
    expect(getExtensionNoticesSeenAt(seen, "remote", "sess-1")).toBe(3000)
    expect(getExtensionNoticesSeenAt(seen, "local", "missing")).toBeUndefined()
  })

  test("unread selects notices newer than the marker, newest first", () => {
    const notices = [notice("a", 1000), notice("b", 2000), notice("c", 3000)]
    expect(selectUnreadExtensionNotices(notices, undefined).map((entry) => entry.id)).toEqual(["c", "b", "a"])
    expect(selectUnreadExtensionNotices(notices, 2000).map((entry) => entry.id)).toEqual(["c"])
    expect(selectUnreadExtensionNotices(notices, 3000)).toEqual([])
  })

  test("the map stays bounded, dropping least recently written entries", () => {
    for (let index = 0; index < MAX_EXTENSION_NOTICES_SEEN_ENTRIES + 10; index += 1) {
      markExtensionNoticesSeen("local", `sess-${index}`, 1000 + index)
    }
    const seen = readExtensionNoticesSeen()
    expect(Object.keys(seen)).toHaveLength(MAX_EXTENSION_NOTICES_SEEN_ENTRIES)
    expect(getExtensionNoticesSeenAt(seen, "local", "sess-0")).toBeUndefined()
    expect(getExtensionNoticesSeenAt(seen, "local", `sess-${MAX_EXTENSION_NOTICES_SEEN_ENTRIES + 9}`)).toBeGreaterThan(0)
  })

  test("marking seen notifies subscribers until they unsubscribe", () => {
    let calls = 0
    const unsubscribe = subscribeExtensionNoticesSeen(() => {
      calls += 1
    })
    markExtensionNoticesSeen("local", "sess-1", 1000)
    expect(calls).toBe(1)
    unsubscribe()
    markExtensionNoticesSeen("local", "sess-1", 2000)
    expect(calls).toBe(1)
  })

  test("newestExtensionNoticeAt finds the max timestamp", () => {
    expect(newestExtensionNoticeAt([])).toBeUndefined()
    expect(newestExtensionNoticeAt([notice("a", 100), notice("b", 500), notice("c", 300)])).toBe(500)
  })
})

describe("extension notice toast guard", () => {
  const now = 1_700_000_000_000

  test("only live entries toast", () => {
    expect(shouldToastExtensionNotice(notice("a", now, "live"), now)).toBe(true)
    expect(shouldToastExtensionNotice(notice("b", now, "history"), now)).toBe(false)
  })

  test("stale server-stamped live entries do not toast", () => {
    const stale = now - STALE_LIVE_NOTICE_TOAST_GUARD_MS - 1
    expect(shouldToastExtensionNotice(notice("a", stale, "live", true), now)).toBe(false)
    expect(shouldToastExtensionNotice(notice("b", stale, "live", false), now)).toBe(true)
  })

  test("fresh server-stamped live entries toast", () => {
    expect(shouldToastExtensionNotice(notice("a", now - 60_000, "live", true), now)).toBe(true)
  })

  test("a skew-corrected receive time toasts a fresh notice on a skewed clock", () => {
    // Client clock 10 min ahead of the server: the raw `createdAt` looks
    // stale, but the corrected receive time proves it just arrived.
    const createdAt = now - 10 * 60_000
    expect(shouldToastExtensionNotice(notice("a", createdAt, "live", true), now)).toBe(false)
    expect(shouldToastExtensionNotice(notice("a", createdAt, "live", true, now - 1_000), now)).toBe(true)
  })

  test("a stale receive time stays quiet even for a fresh-looking createdAt", () => {
    const staleBase = now - STALE_LIVE_NOTICE_TOAST_GUARD_MS - 1
    expect(shouldToastExtensionNotice(notice("a", now - 1_000, "live", true, staleBase), now)).toBe(false)
  })

  test("entries without a corrected receive time keep the legacy behavior", () => {
    expect(shouldToastExtensionNotice(notice("a", now - 60_000, "live", true, undefined), now)).toBe(true)
  })
})

describe("formatExtensionNoticeTime", () => {
  const now = 1_700_000_000_000

  test("formats short relative labels", () => {
    expect(formatExtensionNoticeTime(now, now)).toBe("just now")
    expect(formatExtensionNoticeTime(now - 30_000, now)).toBe("just now")
    expect(formatExtensionNoticeTime(now - 5 * 60_000, now)).toBe("5 min ago")
    expect(formatExtensionNoticeTime(now - 60_000, now)).toBe("1 min ago")
    expect(formatExtensionNoticeTime(now - 2 * 3_600_000, now)).toBe("2 h ago")
    expect(formatExtensionNoticeTime(now - 3 * 86_400_000, now)).toBe("3 d ago")
  })
})
