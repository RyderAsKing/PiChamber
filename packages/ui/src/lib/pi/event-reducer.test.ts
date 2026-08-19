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
  parentId: "u1",
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

  test("hydrates a user message from its non-streaming start event", () => {
    const state = applyPiEvent(createReducerState(), baseEvent("assistant.message.start", 1, {
      messageId: "u1", role: "user", text: "hello Pi", startedAt: 1_000,
    })).state
    const message = state.bySession.get("sess-1")?.messages.get("u1")
    expect(message?.role).toBe("user")
    expect(message?.text).toBe("hello Pi")
    expect(message?.streaming).toBe(false)
  })

  test("preserves the user-message parent for an assistant turn", () => {
    const state = applyPiEvent(createReducerState(), assistantStart()).state
    expect(state.bySession.get("sess-1")?.messages.get("m1")?.parentId).toBe("u1")
  })

  test("assembles canonical assistant message and thinking deltas", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "Hello, ",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.thinking.delta", 3, {
      messageId: "m1", contentIndex: 1, delta: "thoughtful ",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 4, {
      messageId: "m1", contentIndex: 0, delta: "world!",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.thinking.delta", 5, {
      messageId: "m1", contentIndex: 1, delta: "analysis",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.message.end", 6, {
      messageId: "m1", text: "Hello, world!", thinking: "thoughtful analysis",
    })).state

    const message = state.bySession.get("sess-1")?.messages.get("m1")
    expect(message?.text).toBe("Hello, world!")
    expect(message?.thinking).toBe("thoughtful analysis")
    expect(message?.streaming).toBe(false)
    const parts = state.bySession.get("sess-1")?.parts
    expect(parts?.get("m1:text")?.text).toBe("Hello, world!")
    expect(parts?.get("m1:thinking")?.text).toBe("thoughtful analysis")
  })

  test("merges overlapping and cumulative deltas instead of stuttering markdown", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "Let",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 3, {
      messageId: "m1", contentIndex: 0, delta: "Let me look",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.thinking.delta", 4, {
      messageId: "m1", contentIndex: 1, delta: "Let me look at the tests",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.thinking.delta", 5, {
      messageId: "m1", contentIndex: 1, delta: " me look at the tests and documentation",
    })).state
    state = applyPiEvent(state, baseEvent("assistant.message.end", 6, {
      messageId: "m1",
      text: "Let me look at the tests",
      thinking: "Let me look at the tests and documentation",
    })).state

    const session = state.bySession.get("sess-1")
    expect(session?.parts.get("m1:text")?.text).toBe("Let me look at the tests")
    expect(session?.parts.get("m1:thinking")?.text).toBe("Let me look at the tests and documentation")
    expect(session?.messages.get("m1")?.text).toBe("Let me look at the tests")
  })

  test("settles thinking as soon as text or a tool starts on the same message", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.thinking.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "plan the change",
    })).state
    expect(state.bySession.get("sess-1")?.parts.get("m1:thinking")?.streaming).toBe(true)

    state = applyPiEvent(state, baseEvent("assistant.message.delta", 3, {
      messageId: "m1", contentIndex: 1, delta: "Here is the answer.",
    })).state
    expect(state.bySession.get("sess-1")?.parts.get("m1:thinking")?.streaming).toBe(false)
    expect(state.bySession.get("sess-1")?.parts.get("m1:text")?.streaming).toBe(true)

    state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.thinking.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "need a command",
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.start", 3, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "running",
      input: { cmd: "ls" }, startedAt: 1_500,
    })).state
    expect(state.bySession.get("sess-1")?.parts.get("m1:thinking")?.streaming).toBe(false)
  })

  test("tracks canonical tool start, update, and end", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("session.tool.start", 2, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "running",
      input: { cmd: "ls" }, startedAt: 1_500,
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.update", 3, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "running",
      input: { cmd: "ls" }, output: "partial", startedAt: 1_500,
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.end", 4, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "error",
      error: "command failed", isError: true, endedAt: 2_000,
    })).state

    const part = state.bySession.get("sess-1")?.parts.get("p-tool")
    expect(part?.tool?.state).toBe("error")
    expect(part?.tool?.isError).toBe(true)
    expect(part?.tool?.error).toBe("command failed")
    expect(part?.tool?.input).toEqual({ cmd: "ls" })
    expect(part?.tool?.startedAt).toBe(1_500)
    expect(part?.tool?.endedAt).toBe(2_000)
    expect(part?.streaming).toBe(false)
  })

  test("tracks tool execution started after assistant.message.end", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.end", 2, {
      messageId: "m1", text: "Running tool", thinking: "need to run tool",
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.start", 3, {
      toolCallId: "t1", partId: "m1:tool:t1", messageId: "m1", name: "bash", state: "running",
      input: { cmd: "pwd" }, startedAt: 1_000,
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.end", 4, {
      toolCallId: "t1", partId: "m1:tool:t1", messageId: "m1", name: "bash", state: "completed",
      output: "/workspace", endedAt: 1_200,
    })).state

    const session = state.bySession.get("sess-1")
    expect(session?.parts.get("m1:tool:t1")?.tool?.state).toBe("completed")
    expect(session?.parts.get("m1:tool:t1")?.tool?.output).toBe("/workspace")
    expect(session?.partOrder.get("m1")).toContain("m1:tool:t1")
  })

  test("preserves earlier tool output and metadata across partial updates", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("session.tool.start", 2, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "running", startedAt: 1_500,
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.update", 3, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "running",
      output: "chunk-1", metadata: { truncation: { truncated: true } },
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.update", 4, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "running",
      output: "chunk-1 plus more",
    })).state
    state = applyPiEvent(state, baseEvent("session.tool.end", 5, {
      toolCallId: "t1", partId: "p-tool", messageId: "m1", name: "bash", state: "completed", endedAt: 2_000,
    })).state

    const part = state.bySession.get("sess-1")?.parts.get("p-tool")
    expect(part?.tool?.output).toBe("chunk-1 plus more")
    expect(part?.tool?.metadata).toEqual({ truncation: { truncated: true } })
    expect(part?.tool?.startedAt).toBe(1_500)
    expect(part?.tool?.endedAt).toBe(2_000)
    expect(part?.tool?.state).toBe("completed")
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

  test("session.updated advances sequence without changing transcript state", () => {
    const started = applyPiEvent(createReducerState(), assistantStart())
    const updated = applyPiEvent(started.state, baseEvent("session.updated", 2, {
      title: "Fix the parser",
    }))
    expect(updated.didApply).toBe(true)
    expect(updated.state.lastSequence.get("sess-1")).toBe(2)
    expect(updated.state.bySession.get("sess-1")?.messages.get("m1"))
      .toBe(started.state.bySession.get("sess-1")?.messages.get("m1"))
  })

  test("session.error marks active assistant output and lifecycle", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("session.error", 2, {
      code: "PROVIDER_AUTH_REQUIRED", message: "missing api key",
    })).state
    expect(state.bySession.get("sess-1")?.messages.get("m1")?.error?.code)
      .toBe("PROVIDER_AUTH_REQUIRED")
    expect(state.bySession.get("sess-1")?.messages.get("m1")?.streaming).toBe(false)
    expect(state.bySession.get("sess-1")?.messages.get("m1")?.durationMs).toBeGreaterThan(0)
    expect(state.bySession.get("sess-1")?.lifecycle).toBe("error")
  })

  test("session.error completes running tools on the interrupted assistant", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("session.tool.start", 2, {
      toolCallId: "t1",
      partId: "m1:tool:t1",
      messageId: "m1",
      name: "bash",
      state: "running",
      startedAt: 1_000,
    })).state
    state = applyPiEvent(state, baseEvent("session.error", 3, {
      code: "ASSISTANT_ERROR", message: "Stream ended without finish_reason",
    })).state
    const part = state.bySession.get("sess-1")?.parts.get("m1:tool:t1")
    expect(part?.streaming).toBe(false)
    expect(part?.tool?.state).toBe("error")
    expect(state.bySession.get("sess-1")?.streamingMessages.size).toBe(0)
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
          id: "m1", sessionId: "sess-1", directory: "/work", role: "assistant", parentId: "u1",
          text: "Hi", thinking: "", createdAt: 1_000,
        },
        parts: [{ id: "p1", index: 0, type: "text", text: "Hi" }],
      }],
    })
    expect(state.bySession.get("sess-1")?.messages.size).toBe(1)
    expect(state.bySession.get("sess-1")?.messages.get("m1")?.parentId).toBe("u1")
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

  test("restores live streaming UI from an in-flight getSession", () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 12,
      isStreaming: true,
      lifecycle: "busy",
      messages: [{
        message: {
          id: "u1", sessionId: "sess-1", directory: "/work", role: "user",
          text: "run it", createdAt: 1_000,
        },
        parts: [],
      }, {
        message: {
          id: "m1", sessionId: "sess-1", directory: "/work", role: "assistant",
          parentId: "u1", text: "", thinking: "", createdAt: 1_100,
        },
        parts: [{
          id: "p1", index: 0, type: "tool", toolCallId: "tc-1", name: "bash",
          state: "running", startedAt: 1_200,
        }],
      }],
    })
    expect(session.lifecycle).toBe("busy")
    expect(session.streamingMessages.has("m1")).toBe(true)
    expect(session.messages.get("m1")?.streaming).toBe(true)
    expect(session.parts.get("p1")?.streaming).toBe(true)
    expect(session.parts.get("p1")?.tool?.state).toBe("running")
  })

  test("marks a live turn busy when getSession has no assistant yet", () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 4,
      isStreaming: true,
      lifecycle: "busy",
      messages: [{
        message: {
          id: "u1", sessionId: "sess-1", directory: "/work", role: "user",
          text: "run it", createdAt: 1_000,
        },
        parts: [],
      }],
    })
    expect(session.lifecycle).toBe("busy")
    expect(session.streamingMessages.size).toBe(0)
  })

  test("resumes delta streaming on a hydrated message", () => {
    const { state: initial } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 2,
      messages: [{
        message: {
          id: "m1", sessionId: "sess-1", directory: "/work", role: "assistant",
          text: "Hello", thinking: "", createdAt: 1_000,
        },
        parts: [{ id: "m1:text:0", index: 0, type: "text", text: "Hello" }],
      }],
    })
    const updated = applyPiEvent(initial, baseEvent("assistant.message.delta", 3, {
      messageId: "m1", partId: "m1:text:0", contentIndex: 0, delta: " world",
    }))
    expect(updated.didApply).toBe(true)
    const session = updated.state.bySession.get("sess-1") as PiReducerSessionState
    expect(session.parts.get("m1:text:0")?.text).toBe("Hello world")
    expect(session.parts.get("m1:text:0")?.streaming).toBe(true)
    expect(session.messages.get("m1")?.streaming).toBe(true)
    expect(session.streamingMessages.has("m1")).toBe(true)
  })

  test("reconciles synthetic SSE messageId with hydrated session entry", () => {
    const { state: initial } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 2,
      messages: [{
        message: {
          id: "entry_uuid_123", sessionId: "sess-1", directory: "/work", role: "assistant",
          text: "Thinking...", thinking: "", createdAt: 1_000,
        },
        parts: [{ id: "entry_uuid_123:text:0", index: 0, type: "text", text: "Thinking..." }],
      }],
    })
    // SSE emits synthetic messageId: assistant-sess-1-4
    let state = applyPiEvent(initial, baseEvent("assistant.message.delta", 3, {
      messageId: "assistant-sess-1-4", partId: "assistant-sess-1-4:text:0", contentIndex: 0, delta: " and answering",
    })).state
    const session = state.bySession.get("sess-1") as PiReducerSessionState
    expect(session.parts.get("entry_uuid_123:text:0")?.text).toBe("Thinking... and answering")
    expect(session.parts.get("entry_uuid_123:text:0")?.streaming).toBe(true)

    // Tool execution with synthetic messageId
    state = applyPiEvent(state, baseEvent("session.tool.start", 4, {
      toolCallId: "tc-live",
      partId: "assistant-sess-1-4:tool:tc-live",
      messageId: "assistant-sess-1-4",
      name: "bash",
      state: "running",
      input: { command: "ls" },
      startedAt: 1_200,
    })).state
    expect(state.bySession.get("sess-1")?.parts.get("assistant-sess-1-4:tool:tc-live")?.tool?.name).toBe("bash")

    // Message end with synthetic messageId
    state = applyPiEvent(state, baseEvent("assistant.message.end", 5, {
      messageId: "assistant-sess-1-4",
      text: "Thinking... and answering",
      durationMs: 500,
    })).state
    expect(state.bySession.get("sess-1")?.messages.get("entry_uuid_123")?.streaming).toBe(false)
    expect(state.bySession.get("sess-1")?.messages.get("entry_uuid_123")?.durationMs).toBe(500)
  })

  test("aliases a synthetic stream user onto the persisted user with the same text", () => {
    const { state: initial } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 2,
      messages: [{
        message: {
          id: "entry_user_1", sessionId: "sess-1", directory: "/work", role: "user",
          text: "write a 500 words poem", createdAt: 1_000,
        },
        parts: [],
      }],
    })
    const state = applyPiEvent(initial, baseEvent("assistant.message.start", 3, {
      messageId: "user-sess-1-3",
      role: "user",
      text: "write a 500 words poem",
      startedAt: 1_001,
    })).state
    const session = state.bySession.get("sess-1") as PiReducerSessionState
    expect(session.messages.get("user-sess-1-3")?.id).toBe("entry_user_1")
    const projected = projectSession(session)
    expect(projected.messages.filter((message) => message.role === "user")).toHaveLength(1)
    expect(projected.messages[0]?.id).toBe("entry_user_1")

    const withAssistant = applyPiEvent(state, baseEvent("assistant.message.start", 4, {
      messageId: "assistant-sess-1-4",
      role: "assistant",
      parentId: "user-sess-1-3",
      startedAt: 1_002,
    })).state
    expect(projectSession(withAssistant.bySession.get("sess-1") as PiReducerSessionState).messages[1]?.parentId).toBe("entry_user_1")
  })

  test("does not alias a second send of the same text after a completed assistant", () => {
    const { state: initial } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 4,
      messages: [{
        message: {
          id: "entry_user_1", sessionId: "sess-1", directory: "/work", role: "user",
          text: "hello", createdAt: 1_000,
        },
        parts: [],
      }, {
        message: {
          id: "entry_asst_1", sessionId: "sess-1", directory: "/work", role: "assistant",
          text: "hi", thinking: "", createdAt: 1_100, durationMs: 80,
        },
        parts: [{ id: "entry_asst_1:text:0", index: 0, type: "text", text: "hi" }],
      }],
    })
    const state = applyPiEvent(initial, baseEvent("assistant.message.start", 5, {
      messageId: "user-sess-1-5",
      role: "user",
      text: "hello",
      startedAt: 2_000,
    })).state
    const session = state.bySession.get("sess-1") as PiReducerSessionState
    expect(session.messages.get("user-sess-1-5")?.id).toBe("user-sess-1-5")
    expect(projectSession(session).messages.filter((message) => message.role === "user")).toHaveLength(2)
  })

  test("aliases a replayed synthetic user even when completed assistant history follows it", () => {
    const { state: initial } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 4,
      messages: [{
        message: {
          id: "entry_user_1", sessionId: "sess-1", directory: "/work", role: "user",
          text: "find the biggest codebase", createdAt: 1_000,
        },
        parts: [],
      }, {
        message: {
          id: "entry_asst_1", sessionId: "sess-1", directory: "/work", role: "assistant",
          parentId: "entry_user_1", text: "checking", thinking: "", createdAt: 1_100, durationMs: 80,
        },
        parts: [{ id: "entry_asst_1:text:0", index: 0, type: "text", text: "checking" }],
      }],
    })
    const state = applyPiEvent(initial, baseEvent("assistant.message.start", 5, {
      messageId: "user-sess-1-5",
      role: "user",
      text: "find the biggest codebase",
      startedAt: 1_001,
    })).state
    const session = state.bySession.get("sess-1") as PiReducerSessionState
    expect(session.messages.get("user-sess-1-5")?.id).toBe("entry_user_1")
    expect(projectSession(session).messages.filter((message) => message.role === "user")).toHaveLength(1)
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
    expect(projected.messages[0]?.parentId).toBe("u1")
    expect((projected as unknown as { lastSequence?: number }).lastSequence).toBe(undefined)
  })

  test("hides an empty intermediate assistant error after the same turn recovers", () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 5,
      messages: [{
        message: {
          id: "u1", sessionId: "sess-1", directory: "/work", role: "user",
          text: "inspect", createdAt: 1_000,
        },
        parts: [],
      }, {
        message: {
          id: "a-error", sessionId: "sess-1", directory: "/work", role: "assistant",
          parentId: "u1", text: "", thinking: "", createdAt: 1_100,
          error: { code: "ASSISTANT_ERROR", message: "temporary provider failure" },
        },
        parts: [],
      }, {
        message: {
          id: "a-ok", sessionId: "sess-1", directory: "/work", role: "assistant",
          parentId: "u1", text: "Recovered", thinking: "", createdAt: 1_200, durationMs: 100,
        },
        parts: [{ id: "a-ok:text:0", index: 0, type: "text", text: "Recovered" }],
      }],
    })
    expect(projectSession(session).messages.map((message) => message.id)).toEqual(["u1", "a-ok"])
  })

  test("keeps an unrecovered terminal assistant error visible", () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 3,
      messages: [{
        message: {
          id: "u1", sessionId: "sess-1", directory: "/work", role: "user",
          text: "inspect", createdAt: 1_000,
        },
        parts: [],
      }, {
        message: {
          id: "a-error", sessionId: "sess-1", directory: "/work", role: "assistant",
          parentId: "u1", text: "", thinking: "", createdAt: 1_100,
          error: { code: "ASSISTANT_ERROR", message: "provider failed" },
        },
        parts: [],
      }],
    })
    expect(projectSession(session).messages.map((message) => message.id)).toEqual(["u1", "a-error"])
  })

  test("reuses historical projected messages when only the live tail changes", () => {
    const history = Array.from({ length: 200 }, (_, index) => {
      const turn = Math.floor(index / 2)
      const isUser = index % 2 === 0
      const id = isUser ? `u${turn}` : `a${turn}`
      return {
        message: {
          id,
          sessionId: "sess-1",
          directory: "/work",
          role: isUser ? "user" as const : "assistant" as const,
          ...(isUser ? {} : { parentId: `u${turn}` }),
          text: isUser ? `prompt ${turn}` : `reply ${turn}`,
          thinking: "",
          createdAt: index + 1,
          ...(isUser ? {} : { durationMs: 10 }),
        },
        parts: isUser
          ? []
          : [{ id: `${id}:text:0`, index: 0, type: "text" as const, text: `reply ${turn}` }],
      }
    })
    const { state: hydrated } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 200,
      messages: history,
    })
    let state = applyPiEvent(hydrated, baseEvent("assistant.message.start", 201, {
      messageId: "live",
      role: "assistant",
      parentId: "u99",
      startedAt: 10_000,
    })).state
    const beforeSession = state.bySession.get("sess-1") as PiReducerSessionState
    const before = projectSession(beforeSession)

    state = applyPiEvent(state, baseEvent("assistant.message.delta", 202, {
      messageId: "live",
      contentIndex: 0,
      delta: "streaming",
    })).state
    const afterSession = state.bySession.get("sess-1") as PiReducerSessionState
    const after = projectSession(afterSession, { session: beforeSession, projection: before })

    expect(after.messages).toHaveLength(201)
    let remapped = 0
    for (let index = 0; index < 200; index += 1) {
      if (after.messages[index] !== before.messages[index]) remapped += 1
    }
    expect(remapped).toBe(0)
    expect(after.messages[200]).not.toBe(before.messages[200])
    expect(after.messages[200]?.parts[0]?.text).toBe("streaming")
  })

  test("token deltas keep historical part object identity without cloning the full map", () => {
    const history = Array.from({ length: 40 }, (_, index) => {
      const turn = Math.floor(index / 2) + 1
      const isUser = index % 2 === 0
      const id = isUser ? `u${turn}` : `a${turn}`
      return {
        message: {
          id,
          sessionId: "sess-1",
          directory: "/work",
          role: isUser ? "user" as const : "assistant" as const,
          text: isUser ? `ask ${turn}` : `reply ${turn}`,
          thinking: "",
          createdAt: index + 1,
          ...(isUser ? {} : { durationMs: 10 }),
        },
        parts: isUser
          ? []
          : [{ id: `${id}:text:0`, index: 0, type: "text" as const, text: `reply ${turn}` }],
      }
    })
    const { state: hydrated } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 40,
      messages: history,
    })
    const historicalPart = hydrated.bySession.get("sess-1")?.parts.get("a1:text:0")
    expect(historicalPart).toBeDefined()

    let state = applyPiEvent(hydrated, baseEvent("assistant.message.start", 41, {
      messageId: "live",
      role: "assistant",
      parentId: "u20",
      startedAt: 10_000,
    })).state
    const beforeParts = state.bySession.get("sess-1")?.parts
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 42, {
      messageId: "live",
      contentIndex: 0,
      delta: "token",
    })).state
    const afterSession = state.bySession.get("sess-1") as PiReducerSessionState
    expect(afterSession.parts.get("a1:text:0")).toBe(historicalPart)
    expect(afterSession.parts).not.toBe(beforeParts)
    expect(afterSession.lastMutationKind).toBe("part")
    expect(afterSession.lastMutatedMessageId).toBe("live")
  })

  test("returns the previous projection object when nothing visible changed", () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 2,
      messages: [{
        message: {
          id: "u1", sessionId: "sess-1", directory: "/work", role: "user",
          text: "hello", createdAt: 1,
        },
        parts: [],
      }],
    })
    const first = projectSession(session)
    const second = projectSession(session, { session, projection: first })
    expect(second).toBe(first)
  })
})

describe("applyPiEvent reference stability", () => {
  test("preserves unrelated session object identity", () => {
    let state = applyPiEvent(createReducerState(), baseEvent("session.lifecycle", 1, { state: "idle" }, "background")).state
    const background = state.bySession.get("background")
    expect(background).toBeDefined()
    state = applyPiEvent(state, assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "token",
    })).state
    expect(state.bySession.get("background")).toBe(background)
    expect(state.bySession.get("sess-1")).not.toBe(undefined)
    expect(state.bySession.get("sess-1")).not.toBe(background)
  })
})

describe("session.lifecycle", () => {
  test("idle clears leftover streaming flags", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.delta", 2, {
      messageId: "m1", contentIndex: 0, delta: "Hi",
    })).state
    expect(state.bySession.get("sess-1")?.streamingMessages.size).toBeGreaterThan(0)
    state = applyPiEvent(state, baseEvent("session.lifecycle", 3, { state: "idle" })).state
    const session = state.bySession.get("sess-1")
    expect(session?.lifecycle).toBe("idle")
    expect(session?.streamingMessages.size).toBe(0)
    expect(session?.messages.get("m1")?.streaming).toBe(false)
  })
})

describe("Pi usage", () => {
  const sampleUsage = {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 165,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
  }

  test("assistant.message.end attaches usage to the producing assistant message", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.end", 2, {
      messageId: "m1",
      text: "ok",
      durationMs: 100,
      usage: sampleUsage,
    })).state
    const session = state.bySession.get("sess-1")
    expect(session?.messages.get("m1")?.usage).toEqual(sampleUsage)
  })

  test("assistant.message.end without usage leaves the message without usage", () => {
    let state = applyPiEvent(createReducerState(), assistantStart()).state
    state = applyPiEvent(state, baseEvent("assistant.message.end", 2, {
      messageId: "m1",
      text: "ok",
      durationMs: 100,
    })).state
    const session = state.bySession.get("sess-1")
    expect(session?.messages.get("m1")?.usage).toBeFalsy()
  })

  test("hydrateSessionFromDetail carries usage onto assistant messages", () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: "sess-usage", directory: "/work" },
      lastSequence: 5,
      messages: [{
        message: {
          id: "m-usage",
          sessionId: "sess-usage",
          directory: "/work",
          role: "assistant",
          createdAt: 1,
          text: "ok",
          thinking: "",
          model: { providerId: "test", modelId: "model" },
          usage: sampleUsage,
        },
        parts: [],
      }],
    })
    expect(session.messages.get("m-usage")?.usage).toEqual(sampleUsage)
  })

  test("projectSession exposes usage on the public projection", () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: "sess-usage", directory: "/work" },
      lastSequence: 5,
      messages: [{
        message: {
          id: "m-usage",
          sessionId: "sess-usage",
          directory: "/work",
          role: "assistant",
          createdAt: 1,
          text: "ok",
          thinking: "",
          model: { providerId: "test", modelId: "model" },
          usage: sampleUsage,
        },
        parts: [],
      }],
    })
    const projected = projectSession(session)
    const message = projected.messages.find((m) => m.id === "m-usage")
    expect(message?.usage).toEqual(sampleUsage)
  })

  test("hydrateSessionFromDetail locks model and thinking to the last assistant turn", () => {
    const { session } = hydrateSessionFromDetail({
      session: {
        id: "sess-1",
        directory: "/work",
        model: { providerId: "openai", modelId: "gpt-5" },
        thinking: "low",
      },
      lastSequence: 8,
      messages: [
        {
          message: {
            id: "u1", sessionId: "sess-1", directory: "/work", role: "user",
            text: "hi", createdAt: 1,
          },
          parts: [],
        },
        {
          message: {
            id: "a1", sessionId: "sess-1", directory: "/work", role: "assistant",
            text: "ok", thinking: "", createdAt: 2,
            model: { providerId: "anthropic", modelId: "sonnet" },
            thinkingLevel: "high",
          },
          parts: [],
        },
      ],
    })
    expect(session.model).toEqual({ providerId: "anthropic", modelId: "sonnet" })
    expect(session.thinking).toBe("high")
  })
})
