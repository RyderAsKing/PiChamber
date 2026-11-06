import { describe, expect, test } from "bun:test"
import {
  applyPiEvent,
  createReducerState,
  hydrateSessionFromDetail,
  projectSession,
} from "./event-reducer"
import { isPiEvent, PI_BASH_OUTPUT_MAX_CHARS } from "./protocol"
import type { PiBashExecution, PiSessionEvent } from "./protocol"
import type { PiReducerState } from "./event-reducer"
import { mergeHydratedSession } from "@/sync/pi-session-store-helpers"
import { hasSameTranscriptInputs, shouldReuseUserHistory } from "@/sync/suspend-live-tail-records"

const baseEvent = <T extends PiSessionEvent["name"]>(
  name: T,
  sequence: number,
  payload: Extract<PiSessionEvent, { name: T }>["payload"],
): Extract<PiSessionEvent, { name: T }> => ({
  protocolVersion: 1,
  kind: "event",
  name,
  sequence,
  sessionId: "sess-1",
  directory: "/work",
  payload,
} as Extract<PiSessionEvent, { name: T }>)

const running = (overrides: Partial<PiBashExecution> = {}): PiBashExecution => ({
  id: "bash-1",
  command: "ls",
  phase: "running",
  startedAt: 100,
  ...overrides,
})

const apply = (state: PiReducerState, event: PiSessionEvent) => applyPiEvent(state, event).state
const session = (state: PiReducerState) => state.bySession.get("sess-1")!

describe("user shell events", () => {
  test("the public guard accepts every shell event kind", () => {
    expect(isPiEvent(baseEvent("session.bash", 1, { bash: running() }))).toBe(true)
    expect(isPiEvent(baseEvent("session.bash.output", 2, { id: "bash-1", delta: "a" }))).toBe(true)
    expect(isPiEvent(baseEvent("session.bash.recorded", 3, {
      id: "bash-1",
      message: { id: "entry-1", createdAt: 1, customType: "pichamber.bash", details: { command: "ls", output: "" } },
    }))).toBe(true)
  })

  test("streams output into the live execution, then settles it into one transcript row", () => {
    let state = apply(createReducerState(), baseEvent("session.bash", 1, { bash: running() }))
    state = apply(state, baseEvent("session.bash.output", 2, { id: "bash-1", delta: "a\n" }))
    state = apply(state, baseEvent("session.bash.output", 3, { id: "bash-1", delta: "b\n" }))
    expect(session(state).bashExecutions).toEqual([{ ...running(), output: "a\nb\n" }])

    // A phase update without output keeps what already streamed.
    state = apply(state, baseEvent("session.bash", 4, { bash: running({ phase: "completed", exitCode: 0, completedAt: 150 }) }))
    expect(session(state).bashExecutions?.[0]).toMatchObject({ phase: "completed", output: "a\nb\n" })

    state = apply(state, baseEvent("session.bash.recorded", 5, {
      id: "bash-1",
      message: { id: "entry-1", createdAt: 160, customType: "pichamber.bash", details: { command: "ls", output: "a\nb\n", exitCode: 0 } },
    }))
    expect(session(state).bashExecutions).toBeUndefined()
    const projection = projectSession(session(state))
    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]).toMatchObject({
      id: "entry-1",
      role: "extension",
      customType: "pichamber.bash",
      details: { command: "ls", output: "a\nb\n", exitCode: 0 },
    })
  })

  test("a reset frame replaces output and the live tail stays capped", () => {
    let state = apply(createReducerState(), baseEvent("session.bash", 1, { bash: running() }))
    state = apply(state, baseEvent("session.bash.output", 2, { id: "bash-1", delta: "x".repeat(PI_BASH_OUTPUT_MAX_CHARS) }))
    state = apply(state, baseEvent("session.bash.output", 3, { id: "bash-1", delta: "tail" }))
    const output = session(state).bashExecutions?.[0]?.output ?? ""
    expect(output).toHaveLength(PI_BASH_OUTPUT_MAX_CHARS)
    expect(output.endsWith("tail")).toBe(true)

    state = apply(state, baseEvent("session.bash.output", 4, { id: "bash-1", output: "fresh", reset: true }))
    expect(session(state).bashExecutions?.[0]?.output).toBe("fresh")
  })

  test("output for an unknown execution leaves the session list untouched", () => {
    let state = apply(createReducerState(), baseEvent("session.bash", 1, { bash: running() }))
    const before = session(state).bashExecutions
    state = apply(state, baseEvent("session.bash.output", 2, { id: "other", delta: "x" }))
    expect(session(state).bashExecutions).toBe(before)
  })

  test("a recorded entry with no live execution still lands in the transcript", () => {
    const state = apply(createReducerState(), baseEvent("session.bash.recorded", 1, {
      message: { id: "entry-9", createdAt: 5, customType: "pichamber.bash", details: { command: "pwd", output: "/work\n" } },
    }))
    expect(session(state).bashExecutions).toBeUndefined()
    expect(projectSession(session(state)).messages.map((message) => message.id)).toEqual(["entry-9"])
  })

  test("snapshots replace the live list, and an absent list keeps it", () => {
    let state = apply(createReducerState(), baseEvent("session.bash", 1, { bash: running() }))
    const snapshot = (sequence: number, bashExecutions?: PiBashExecution[]) => baseEvent("session.snapshot", sequence, {
      snapshot: {
        sessionId: "sess-1",
        directory: "/work",
        lastSequence: sequence,
        isStreaming: false,
        lifecycle: "idle",
        ...(bashExecutions ? { bashExecutions } : {}),
      },
    })
    state = apply(state, snapshot(2))
    expect(session(state).bashExecutions).toHaveLength(1)
    state = apply(state, snapshot(3, [running({ id: "bash-2", command: "make" })]))
    expect(session(state).bashExecutions?.map((execution) => execution.id)).toEqual(["bash-2"])
    state = apply(state, snapshot(4, []))
    expect(session(state).bashExecutions).toBeUndefined()
  })

  test("details hydrate the live list, and a stale detail keeps newer live state", () => {
    const detail = (lastSequence: number, bashExecutions: PiBashExecution[]) => ({
      session: { id: "sess-1", directory: "/work" },
      lastSequence,
      isStreaming: false,
      lifecycle: "idle" as const,
      messages: [],
      bashExecutions,
    })
    const hydrated = hydrateSessionFromDetail(detail(4, [running()])).session
    expect(hydrated.bashExecutions).toEqual([running()])

    let state = apply(createReducerState(), baseEvent("session.bash", 10, { bash: running({ id: "bash-new" }) }))
    state = apply(state, baseEvent("assistant.message.start", 11, { messageId: "user-1", role: "user", text: "hi", startedAt: 1 }))
    const stale = hydrateSessionFromDetail(detail(4, [])).session
    const merged = mergeHydratedSession(session(state), stale)
    expect(merged.bashExecutions?.map((execution) => execution.id)).toEqual(["bash-new"])
  })

  test("shell output does not invalidate transcript consumers", () => {
    let state = apply(createReducerState(), baseEvent("assistant.message.start", 1, { messageId: "user-1", role: "user", text: "hi", startedAt: 1 }))
    state = apply(state, baseEvent("session.bash", 2, { bash: running() }))
    const before = session(state)
    state = apply(state, baseEvent("session.bash.output", 3, { id: "bash-1", delta: "x" }))
    const after = session(state)
    expect(after).not.toBe(before)
    expect(hasSameTranscriptInputs(before, after)).toBe(true)
    expect(shouldReuseUserHistory(before, after)).toBe(true)

    state = apply(state, baseEvent("session.bash.recorded", 4, {
      id: "bash-1",
      message: { id: "entry-1", createdAt: 2, customType: "pichamber.bash", details: { command: "ls", output: "x" } },
    }))
    expect(hasSameTranscriptInputs(after, session(state))).toBe(false)
  })
})
