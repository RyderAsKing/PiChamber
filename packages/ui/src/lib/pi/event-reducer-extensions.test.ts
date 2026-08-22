import { describe, expect, test } from "bun:test"
import {
  applyPiEvent,
  createReducerState,
  dismissExtensionDialog,
  hydrateSessionFromDetail,
  projectSession,
} from "./event-reducer"
import { isPiEvent } from "./protocol"
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

describe("extension event protocol", () => {
  test("guards accept every extension event kind", () => {
    const events: PiSessionEvent[] = [
      baseEvent("extension.entry", 1, { id: "e1", customType: "pichamber.ui", data: {}, createdAt: 1 }),
      baseEvent("extension.message", 2, { id: "cm1", customType: "x", text: "hi", createdAt: 2 }),
      baseEvent("extension.notify", 3, { message: "done", level: "info" }),
      baseEvent("extension.status", 4, { key: "k", text: "v" }),
      baseEvent("extension.widget", 5, { key: "w", lines: ["a"] }),
      baseEvent("extension.dialog", 6, { requestId: "r1", method: "confirm", title: "T" }),
      baseEvent("extension.error", 7, { source: "/ext.ts", message: "boom" }),
    ]
    for (const event of events) expect(isPiEvent(event)).toBe(true)
  })
})

describe("extension event reduction", () => {
  test("appends extension entries and messages as extension-role items in order", () => {
    let state = applyPiEvent(createReducerState(), baseEvent("extension.entry", 1, {
      id: "entry-1",
      customType: "pichamber.ui",
      data: { component: "progress" },
      createdAt: 100,
    })).state
    state = applyPiEvent(state, baseEvent("extension.message", 2, {
      id: "custom-1",
      customType: "my-ext",
      text: "note",
      details: { a: 1 },
      createdAt: 200,
    })).state

    const projection = projectSession(state.bySession.get("sess-1")!)
    expect(projection.messages.map((message) => message.role)).toEqual(["extension", "extension"])
    const [first, second] = projection.messages
    expect(first?.id).toBe("entry-1")
    expect(first?.customType).toBe("pichamber.ui")
    expect(first?.data).toEqual({ component: "progress" })
    expect(second?.id).toBe("custom-1")
    expect(second?.text).toBe("note")
    expect(second?.details).toEqual({ a: 1 })
  })

  test("tracks status and widget set/clear semantics per key", () => {
    let state = applyPiEvent(createReducerState(), baseEvent("extension.status", 1, { key: "a", text: "one" })).state
    state = applyPiEvent(state, baseEvent("extension.status", 2, { key: "b", text: "two" })).state
    state = applyPiEvent(state, baseEvent("extension.status", 3, { key: "a" })).state
    const session = state.bySession.get("sess-1")!
    expect([...session.extensionStatuses.entries()]).toEqual([["b", "two"]])

    state = applyPiEvent(state, baseEvent("extension.widget", 4, { key: "todo", lines: ["x"], placement: "belowEditor" })).state
    state = applyPiEvent(state, baseEvent("extension.widget", 5, { key: "gone", lines: ["y"] })).state
    state = applyPiEvent(state, baseEvent("extension.widget", 6, { key: "gone" })).state
    expect([...state.bySession.get("sess-1")!.extensionWidgets.entries()].map(([key, value]) => [key, value.placement])).toEqual([
      ["todo", "belowEditor"],
    ])
  })

  test("queues dialogs by requestId without stacking replays", () => {
    let state = applyPiEvent(createReducerState(), baseEvent("extension.dialog", 1, {
      requestId: "r1",
      method: "select",
      title: "Pick",
      options: ["A", "B"],
    })).state
    state = applyPiEvent(state, baseEvent("extension.dialog", 1, {
      requestId: "r1",
      method: "select",
      title: "Pick",
      options: ["A", "B"],
    })).state
    // A lower-sequence replay is dropped entirely.
    state = applyPiEvent(state, baseEvent("extension.dialog", 2, {
      requestId: "r2",
      method: "confirm",
      title: "Sure?",
    })).state
    const session = state.bySession.get("sess-1")!
    expect(session.extensionDialogs.map((dialog) => dialog.requestId)).toEqual(["r1", "r2"])

    const dismissed = dismissExtensionDialog(state, "sess-1", "r1")
    expect(dismissed.bySession.get("sess-1")?.extensionDialogs.map((dialog) => dialog.requestId)).toEqual(["r2"])
    expect(dismissExtensionDialog(state, "sess-1", "missing")).toBe(state)
  })

  test("bounds notice and error feeds to the newest entries", () => {
    let state = createReducerState()
    for (let index = 0; index < 15; index += 1) {
      state = applyPiEvent(state, baseEvent("extension.notify", index + 1, {
        message: `n${index}`,
        level: "info",
      })).state
    }
    state = applyPiEvent(state, baseEvent("extension.error", 16, { source: "s", message: "boom" })).state
    const session = state.bySession.get("sess-1")!
    expect(session.extensionNotices).toHaveLength(10)
    expect(session.extensionNotices.at(-1)?.message).toBe("n14")
    expect(session.extensionErrors).toHaveLength(1)
  })
})

describe("hydrateSessionFromDetail with extension content", () => {
  test("restores extension-role messages from a snapshot", () => {
    const { state, session } = hydrateSessionFromDetail({
      session: { id: "sess-1", directory: "/work" },
      lastSequence: 7,
      messages: [
        {
          message: {
            id: "e1",
            role: "extension",
            customType: "pichamber.ui",
            createdAt: 10,
            data: { component: "kv", props: { rows: [] } },
          },
          parts: [],
        },
        {
          message: {
            id: "cm1",
            role: "extension",
            customType: "my-ext",
            createdAt: 20,
            text: "inline note",
            details: { ok: true },
          },
          parts: [],
        },
      ],
    })
    expect(session.lastSequence).toBe(7)
    const projection = projectSession(state.bySession.get("sess-1")!)
    expect(projection.messages.map((message) => message.id)).toEqual(["e1", "cm1"])
    const [entry, message] = projection.messages
    expect(entry?.role).toBe("extension")
    expect(entry?.customType).toBe("pichamber.ui")
    expect(entry?.data).toEqual({ component: "kv", props: { rows: [] } })
    expect(message?.role).toBe("extension")
    expect(message?.text).toBe("inline note")
    expect(message?.details).toEqual({ ok: true })
  })
})
