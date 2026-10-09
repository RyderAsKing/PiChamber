import { describe, expect, test } from "bun:test"
import { isPiEvent, PI_EVENT_KINDS, PI_PUBLIC_PROTOCOL_VERSION } from "./protocol"

describe("protocol constants", () => {
  test("public protocol version is 1", () => {
    expect(PI_PUBLIC_PROTOCOL_VERSION).toBe(1)
  })

  test("event kinds cover every canonical name", () => {
    expect(PI_EVENT_KINDS).toContain("session.snapshot")
    expect(PI_EVENT_KINDS).toContain("session.lifecycle")
    expect(PI_EVENT_KINDS).toContain("session.updated")
    expect(PI_EVENT_KINDS).toContain("assistant.message.start")
    expect(PI_EVENT_KINDS).toContain("assistant.message.delta")
    expect(PI_EVENT_KINDS).toContain("assistant.message.end")
    expect(PI_EVENT_KINDS).toContain("assistant.thinking.delta")
    expect(PI_EVENT_KINDS).toContain("session.tool.start")
    expect(PI_EVENT_KINDS).toContain("session.tool.update")
    expect(PI_EVENT_KINDS).toContain("session.tool.end")
    expect(PI_EVENT_KINDS).toContain("session.queue")
    expect(PI_EVENT_KINDS).toContain("session.model")
    expect(PI_EVENT_KINDS).toContain("session.thinking")
    expect(PI_EVENT_KINDS).toContain("session.compaction")
    expect(PI_EVENT_KINDS).toContain("session.error")
    expect(PI_EVENT_KINDS).toContain("session.interrupted")
    expect(PI_EVENT_KINDS).toContain("session.input")
  })
})

describe("isPiEvent", () => {
  test("accepts valid envelopes", () => {
    const event = {
      protocolVersion: 1,
      kind: "event",
      name: "session.lifecycle",
      sequence: 1,
      sessionId: "s1",
      directory: "/work",
      payload: { state: "busy" },
    }
    expect(isPiEvent(event)).toBe(true)
  })

  test("accepts session.updated title envelopes", () => {
    expect(isPiEvent({
      protocolVersion: 1,
      kind: "event",
      name: "session.updated",
      sequence: 1,
      sessionId: "s1",
      directory: "/work",
      payload: { title: "Named from another device" },
    })).toBe(true)
  })

  test("accepts extension.notify envelopes with and without daemon identity", () => {
    expect(isPiEvent({
      protocolVersion: 1,
      kind: "event",
      name: "extension.notify",
      sequence: 3,
      sessionId: "s1",
      directory: "/work",
      payload: { message: "done", level: "info" },
    })).toBe(true)
    // Newer servers attach the stable notice id and daemon timestamp so
    // reconnect replays and snapshot history reconcile against the same id.
    expect(isPiEvent({
      protocolVersion: 1,
      kind: "event",
      name: "extension.notify",
      sequence: 4,
      sessionId: "s1",
      directory: "/work",
      payload: { message: "done", level: "warning", id: "notice-1", createdAt: 1_700_000_000_000 },
    })).toBe(true)
    // Newer servers also sample their wall clock at publish so clients can
    // correct the toast freshness guard for clock skew.
    expect(isPiEvent({
      protocolVersion: 1,
      kind: "event",
      name: "extension.notify",
      sequence: 5,
      sessionId: "s1",
      directory: "/work",
      payload: {
        message: "done",
        level: "info",
        id: "notice-2",
        createdAt: 1_700_000_000_000,
        serverNow: 1_700_000_000_100,
      },
    })).toBe(true)
  })

  test("accepts session.input envelopes", () => {
    expect(isPiEvent({
      protocolVersion: 1,
      kind: "event",
      name: "session.input",
      sequence: 7,
      sessionId: "s1",
      directory: "/work",
      payload: { pending: { count: 2, kind: "approval", since: 50 } },
    })).toBe(true)
    expect(isPiEvent({
      protocolVersion: 1,
      kind: "event",
      name: "session.input",
      sequence: 8,
      sessionId: "s1",
      directory: "/work",
      payload: { pending: null },
    })).toBe(true)
    // Newer servers sample their wall clock at publish so clients can
    // correct `since` for clock skew; older servers omit the field.
    expect(isPiEvent({
      protocolVersion: 1,
      kind: "event",
      name: "session.input",
      sequence: 9,
      sessionId: "s1",
      directory: "/work",
      payload: { pending: { count: 1, kind: "input", since: 50 }, serverNow: 1_700_000_000_000 },
    })).toBe(true)
  })

  test("rejects unrelated objects", () => {
    expect(isPiEvent(null)).toBe(false)
    expect(isPiEvent(undefined)).toBe(false)
    expect(isPiEvent({})).toBe(false)
    expect(isPiEvent({ kind: "response" })).toBe(false)
    expect(isPiEvent({ kind: "event", name: "unknown" })).toBe(false)
    expect(isPiEvent({
      protocolVersion: 1,
      kind: "event",
      name: "session.lifecycle",
      sequence: -1,
      sessionId: "s1",
      directory: "/work",
      payload: { state: "busy" },
    })).toBe(false)
    expect(isPiEvent({
      protocolVersion: 2,
      kind: "event",
      name: "session.lifecycle",
      sequence: 1,
      sessionId: "s1",
      directory: "/work",
      payload: { state: "busy" },
    })).toBe(false)
  })

  test("rejects strings and primitives", () => {
    expect(isPiEvent("event")).toBe(false)
    expect(isPiEvent(42)).toBe(false)
    expect(isPiEvent(true)).toBe(false)
  })
})
