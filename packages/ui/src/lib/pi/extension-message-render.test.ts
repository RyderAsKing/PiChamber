import { describe, expect, test } from "bun:test"
import {
  applyPiEvent,
  createReducerState,
  hydrateSessionFromDetail,
  projectSession,
} from "./event-reducer"
import type { PiSessionEvent } from "./protocol"
import { piMessageToRecord } from "@/lib/chat/pi-to-renderable"

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

const RENDER = {
  message: ["✓ Explore repo completed", "  3 tool uses · 12.4k tokens"],
  messageExpanded: ["✓ Explore repo completed", "  3 tool uses · 12.4k tokens", "  files: src/index.ts, src/util.ts"],
}

describe("extension.message render (live event)", () => {
  test("stores a valid render on the reducer message and projects it", () => {
    const state = applyPiEvent(createReducerState(), baseEvent("extension.message", 1, {
      id: "cm1",
      customType: "subagent-notification",
      text: "Explore repo completed",
      details: { tools: 3 },
      render: RENDER,
      createdAt: 100,
    })).state

    const stored = state.bySession.get("sess-1")!.messages.get("cm1")!
    expect(stored.render).toEqual(RENDER)

    const projection = projectSession(state.bySession.get("sess-1")!)
    expect(projection.messages[0]?.render).toEqual(RENDER)
  })

  test("leaves the message unchanged when render is absent", () => {
    const state = applyPiEvent(createReducerState(), baseEvent("extension.message", 1, {
      id: "cm1",
      customType: "my-ext",
      text: "note",
      details: { a: 1 },
      createdAt: 100,
    })).state

    const stored = state.bySession.get("sess-1")!.messages.get("cm1")!
    expect(stored.render).toBeUndefined()
    expect("render" in stored).toBe(false)

    const projection = projectSession(state.bySession.get("sess-1")!)
    expect(projection.messages[0]?.render).toBeUndefined()
  })

  test("drops invalid render shapes", () => {
    const cases: Array<{ render: unknown; expected: { message: string[] } | undefined }> = [
      { render: "just a string", expected: undefined },
      { render: 42, expected: undefined },
      { render: { message: "not an array" }, expected: undefined },
      { render: { message: [] }, expected: undefined },
      { render: { message: [42] }, expected: undefined },
      // Valid collapsed lines survive a corrupt expanded view.
      { render: { message: ["ok"], messageExpanded: "not an array" }, expected: { message: ["ok"] } },
      { render: { message: ["ok"], messageExpanded: [] }, expected: { message: ["ok"] } },
      { render: { message: ["ok"], messageExpanded: [null] }, expected: { message: ["ok"] } },
    ]
    for (const { render, expected } of cases) {
      const state = applyPiEvent(createReducerState(), baseEvent("extension.message", 1, {
        id: "cm1",
        customType: "my-ext",
        text: "note",
        createdAt: 100,
        render: render as never,
      })).state
      expect(state.bySession.get("sess-1")!.messages.get("cm1")!.render).toEqual(expected)
    }
  })
})

describe("extension message render (snapshot hydration)", () => {
  test("passes render through hydration and projection", () => {
    const { state } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 3,
      messages: [
        {
          message: {
            id: "cm1",
            role: "extension",
            customType: "subagent-notification",
            createdAt: 100,
            text: "Explore repo completed",
            details: { tools: 3 },
            render: RENDER,
          },
          parts: [],
        },
      ],
    })

    const projection = projectSession(state.bySession.get("sess-1")!)
    expect(projection.messages[0]?.render).toEqual(RENDER)
  })

  test("drops an invalid snapshot render", () => {
    const { state } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 3,
      messages: [
        {
          message: {
            id: "cm1",
            role: "extension",
            customType: "my-ext",
            createdAt: 100,
            text: "note",
            render: { message: "corrupt" } as never,
          },
          parts: [],
        },
      ],
    })

    const projection = projectSession(state.bySession.get("sess-1")!)
    expect(projection.messages[0]?.render).toBeUndefined()
  })

  test("live delivery and snapshot reload produce the same renderable fields", () => {
    const liveState = applyPiEvent(createReducerState(), baseEvent("extension.message", 1, {
      id: "cm1",
      customType: "subagent-notification",
      text: "Explore repo completed",
      details: { tools: 3 },
      render: RENDER,
      createdAt: 100,
    })).state
    const liveRecord = piMessageToRecord(
      projectSession(liveState.bySession.get("sess-1")!).messages[0]!,
      "sess-1",
    )

    const { state: snapshotState } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 1,
      messages: [
        {
          message: {
            id: "cm1",
            role: "extension",
            customType: "subagent-notification",
            createdAt: 100,
            text: "Explore repo completed",
            details: { tools: 3 },
            render: RENDER,
          },
          parts: [],
        },
      ],
    })
    const snapshotRecord = piMessageToRecord(
      projectSession(snapshotState.bySession.get("sess-1")!).messages[0]!,
      "sess-1",
    )

    expect(snapshotRecord.info).toEqual(liveRecord.info)
    expect((snapshotRecord.info as { render?: unknown }).render).toEqual(RENDER)
  })

  test("pi-to-renderable omits render when absent", () => {
    const { state } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 1,
      messages: [
        {
          message: {
            id: "cm1",
            role: "extension",
            customType: "my-ext",
            createdAt: 100,
            text: "note",
            details: { a: 1 },
          },
          parts: [],
        },
      ],
    })
    const record = piMessageToRecord(
      projectSession(state.bySession.get("sess-1")!).messages[0]!,
      "sess-1",
    )
    expect("render" in record.info).toBe(false)
    expect(record.info).toMatchObject({ customType: "my-ext", text: "note", details: { a: 1 } })
  })
})
