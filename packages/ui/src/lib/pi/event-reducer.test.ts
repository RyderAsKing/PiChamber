import { describe, expect, test } from "bun:test"
import {
  applyPiEvent,
  applyPiEvents,
  createReducerState,
  hydrateSessionFromDetail,
  projectSession,
  type PiReducerSessionState,
} from "./event-reducer"
import type { PiSessionEvent } from "./protocol"

const baseEvent = <T extends PiSessionEvent["name"]>(
  name: T,
  sequence: number,
  payload: Extract<PiSessionEvent, { name: T }>["payload"],
  sessionId = "sess-1",
  directory = "/work",
): Extract<PiSessionEvent, { name: T }> => ({
  protocolVersion: 1,
  kind: "event",
  name,
  sequence,
  sessionId,
  directory,
  payload,
} as Extract<PiSessionEvent, { name: T }>)

const assistantStart = (sequence = 1) => baseEvent("assistant.message.start", sequence, {
  messageId: "m1",
  role: "assistant",
  startedAt: 1_000,
})

describe("applyPiEvent", () => {
  test("rejects out-of-order events without applying them", () => {
    const state = createReducerState()
    const applied = applyPiEvent(state, baseEvent("session.lifecycle", 1, { state: "busy" }))
    const outOfOrder = applyPiEvent(applied.state, baseEvent("session.lifecycle", 1, { state: "idle" }))
    expect(outOfOrder.didApply).toBe(false)
    expect(applied.state.bySession.get("sess-1")?.lifecycle).toBe("busy")
  })

  test("assembles canonical assistant message and thinking deltas", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "Hello, ",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.thinking.delta", 3, {
      messageId: "m1", contentIndex: 0, delta: "thoughtful ",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 4, {
      messageId: "m1", contentIndex: 1, delta: "world!",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.message.end", 5, {
      messageId: "m1", text: "Hello, world!", thinking: "thoughtful ",
    })).state

    const message = state.bySession.get("sess-1")?.messages.get("m1")
    expect(message?.text).toBe("Hello, world!")
    expect(message?.thinking).toBe("thoughtful ")
    expect(message?.streaming).toBe(false)
  })

  test("tracks canonical tool start, update, and end", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("session.tool.start", 2, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "running",
      input: { cmd: "ls" }, startedAt: 1_500,
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.update", 3, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "running",
      input: { cmd: "ls" }, startedAt: 1_500,
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.end", 4, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "error",
      isError: true, endedAt: 2_000,
    })).state

    const part = state.bySession.get("sess-1")?.parts.get("p-tool")
    expect(part?.tool?.state).toBe("error")
    expect(part?.tool?.isError).toBe(true)
    expect(part?.streaming).toBe(false)
  })

  test("session.interrupted marks active assistant output as an error", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "halfway",
    })).state
    state = applyPiEvent(state, baseEvent("session.interrupted", 3, {
      reason: "daemon-crash", streaming: true,
    })).state
    const message = state.bySession.get("sess-1")?.messages.get("m1")
    expect(message?.streaming).toBe(false)
    expect(message?.error?.code).toBe("SESSION_INTERRUPTED")
    expect(state.bySession.get("sess-1")?.lifecycle).toBe("interrupted")
  })

  test("session.error marks active assistant output and lifecycle", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("session.error", 2, {
      code: "PROVIDER_AUTH_REQUIRED", message: "missing api key",
    })).state
    expect(state.bySession.get("sess-1")?.messages.get("m1")?.error?.code)
      .toBe("PROVIDER_AUTH_REQUIRED")
    expect(state.bySession.get("sess-1")?.lifecycle).toBe("error")
  })

  test("queue, model, and thinking events update session state", () => {
    let state = createReducerState()
    state = applyPiEvent(state, baseEvent("session.queue", 1, { steering: 2, followUp: 3 })).state
    state = applyPiEvent(state, baseEvent("session.model", 2, {
      model: { providerId: "p", modelId: "m" },
    })).state
    state = applyPiEvent(state, baseEvent("session.thinking", 3, { thinking: "high" })).state
    const session = state.bySession.get("sess-1")
    expect(session?.queue).toEqual({ steering: 2, followUp: 3 })
    expect(session?.model).toEqual({ providerId: "p", modelId: "m" })
    expect(session?.thinking).toBe("high")
  })
})

describe("applyPiEvents", () => {
  test("counts applied and skipped events separately", () => {
    const result = applyPiEvents(createReducerState(), [
      baseEvent("session.lifecycle", 1, { state: "busy" }),
      baseEvent("session.lifecycle", 1, { state: "idle" }),
      baseEvent("session.lifecycle", 2, { state: "idle" }),
    ])
    expect(result.applied).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.state.bySession.get("sess-1")?.lifecycle).toBe("idle")
  })
})

describe("hydrateSessionFromDetail", () => {
  test("seeds persisted messages and rejects covered sequences", () => {
    const { state } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 5,
      messages: [{
        message: {
          id: "m1", sessionId: "sess-1", directory: "/work", role: "assistant",
          text: "Hi", thinking: "", createdAt: 1_000,
        },
        parts: [{ id: "p1", index: 0, type: "text", text: "Hi" }],
      }],
    })
    expect(state.bySession.get("sess-1")?.messages.size).toBe(1)
    expect(applyPiEvent(state, baseEvent("session.lifecycle", 5, { state: "busy" })).didApply).toBe(false)
    expect(applyPiEvent(state, baseEvent("session.lifecycle", 6, { state: "busy" })).didApply).toBe(true)
  })

  test("preserves hydrated tool state", () => {
    const { state } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 0,
      messages: [{
        message: {
          id: "m1", sessionId: "sess-1", directory: "/work", role: "assistant",
          text: "done", thinking: "", createdAt: 1_000,
        },
        parts: [{
          id: "p1", index: 0, type: "tool", toolCallId: "tc-1", name: "bash",
          state: "completed", output: { result: "ok" }, endedAt: 1_500,
        }],
      }],
    })
    const session = state.bySession.get("sess-1") as PiReducerSessionState
    expect(session.parts.get("p1")?.tool?.state).toBe("completed")
  })
})

describe("projectSession", () => {
  test("returns a UI projection without sequencing internals", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "Hi",
    })).state
    const session = state.bySession.get("sess-1") as PiReducerSessionState
    const projected = projectSession(session)
    expect(projected.messages[0]?.parts[0]?.text).toBe("Hi")
    expect(projected.messages[0]?.parts[0]?.streaming).toBe(true)
    expect((projected as unknown as { lastSequence?: number }).lastSequence).toBe(undefined)
  })
})
