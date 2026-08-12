import { describe, expect, test } from "bun:test"
import { isPiEvent, PI_EVENT_KINDS, PI_PUBLIC_PROTOCOL_VERSION } from "./protocol"

describe("protocol constants", () => {
  test("public protocol version is 1", () => {
    expect(PI_PUBLIC_PROTOCOL_VERSION).toBe(1)
  })

  test("event kinds cover every canonical name", () => {
    expect(PI_EVENT_KINDS).toContain("session.snapshot")
    expect(PI_EVENT_KINDS).toContain("session.lifecycle")
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
