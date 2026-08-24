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
      baseEvent("extension.catalog", 4, { providers: true }),
      baseEvent("extension.editor", 5, { text: "draft" }),
      baseEvent("extension.title", 6, { title: "Mode" }),
      baseEvent("extension.status", 7, { key: "k", text: "v" }),
      baseEvent("extension.widget", 8, { key: "w", lines: ["a"] }),
      baseEvent("extension.dialog", 9, { requestId: "r1", method: "confirm", title: "T" }),
      baseEvent("extension.dialog.dismiss", 10, { requestId: "r1", reason: "answered" }),
      baseEvent("extension.ui", 11, { id: "panel-1", title: "Panel", component: "progress", props: { value: 10 } }),
      baseEvent("extension.app", 12, { appId: "app-1", title: "App", html: "<p>hi</p>" }),
      baseEvent("extension.error", 13, { source: "/ext.ts", message: "boom" }),
      baseEvent("session.tree.updated", 14, {}),
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

  test("tracks catalog, tree, editor, and window-title state", () => {
    let state = applyPiEvent(createReducerState(), baseEvent("extension.catalog", 1, { commands: true })).state
    state = applyPiEvent(state, baseEvent("session.tree.updated", 2, {})).state
    state = applyPiEvent(state, baseEvent("extension.editor", 3, { text: "replacement" })).state
    state = applyPiEvent(state, baseEvent("extension.title", 4, { title: "Plan mode" })).state
    let session = state.bySession.get("sess-1")!
    expect(session.extensionCatalogRevision).toBe(1)
    expect(session.sessionTreeRevision).toBe(1)
    expect(session.extensionEditor).toEqual({ text: "replacement", sequence: 3 })
    expect(session.extensionTitle).toBe("Plan mode")

    state = applyPiEvent(state, baseEvent("extension.title", 5, {})).state
    session = state.bySession.get("sess-1")!
    expect(session.extensionTitle).toBe(undefined)
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

    state = applyPiEvent(state, baseEvent("extension.dialog.dismiss", 3, {
      requestId: "r1",
      reason: "timeout",
    })).state
    expect(state.bySession.get("sess-1")?.extensionDialogs.map((dialog) => dialog.requestId)).toEqual(["r2"])

    const dismissed = dismissExtensionDialog(state, "sess-1", "r2")
    expect(dismissed.bySession.get("sess-1")?.extensionDialogs).toEqual([])
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

describe("snapshot extension state", () => {
  test("restores live status, widget, and dialog state from a snapshot", () => {
    let state = createReducerState()
    // Simulate snapshot arriving with extension live state for reconnect
    state = applyPiEvent(state, baseEvent("session.snapshot", 10, {
      snapshot: {
        sessionId: "sess-1",
        directory: "/work",
        isStreaming: false,
        lifecycle: "idle",
        queue: { steering: 0, followUp: 0 },
        lastSequence: 10,
        extensionStatuses: [{ key: "a", text: "one" }, { key: "b", text: "two" }],
        extensionWidgets: [{ key: "w", lines: ["hello"], placement: "aboveEditor" }],
        extensionDialogs: [{ requestId: "r1", method: "confirm", title: "Sure?", message: "confirm?" }],
        extensionTitle: "Build mode",
      },
    } as never)).state
    const session = state.bySession.get("sess-1")!
    expect([...session.extensionStatuses.entries()]).toEqual([["a", "one"], ["b", "two"]])
    expect([...session.extensionWidgets.entries()].map(([key, value]) => [key, value.lines])).toEqual([["w", ["hello"]]])
    expect(session.extensionDialogs.map((dialog) => dialog.requestId)).toEqual(["r1"])
    expect(session.extensionTitle).toBe("Build mode")

    state = applyPiEvent(state, baseEvent("session.snapshot", 11, {
      snapshot: {
        sessionId: "sess-1",
        directory: "/work",
        isStreaming: false,
        lifecycle: "idle",
        queue: { steering: 0, followUp: 0 },
        lastSequence: 11,
        extensionDialogs: [],
      },
    } as never)).state
    expect(state.bySession.get("sess-1")!.extensionDialogs).toEqual([])
    expect(state.bySession.get("sess-1")!.extensionTitle).toBe(undefined)

    // Later delta should merge without wiping snapshot state
    state = applyPiEvent(state, baseEvent("extension.status", 12, { key: "c", text: "three" })).state
    expect([...state.bySession.get("sess-1")!.extensionStatuses.keys()].sort()).toEqual(["a", "b", "c"])
  })
})

describe("live panels and app surfaces", () => {
  const panelPayload = {
    id: "subagents",
    title: "Sub-agents",
    component: "table",
    props: { columns: ["Agent", "Status"], rows: [["research", "running"]] },
  }

  test("panels are latest-wins per id and removable", () => {
    let state = applyPiEvent(createReducerState(), baseEvent("extension.ui", 1, panelPayload)).state
    const updated = {
      ...panelPayload,
      props: { columns: ["Agent", "Status"], rows: [["research", "done"]] },
    }
    state = applyPiEvent(state, baseEvent("extension.ui", 2, updated)).state
    let session = state.bySession.get("sess-1")!
    expect(session.extensionPanels.size).toBe(1)
    expect(session.extensionPanels.get("subagents")?.props).toEqual(updated.props)

    // A payload without component/title unregisters too.
    state = applyPiEvent(state, baseEvent("extension.ui", 3, { id: "subagents" })).state
    session = state.bySession.get("sess-1")!
    expect(session.extensionPanels.has("subagents")).toBe(false)

    state = applyPiEvent(state, baseEvent("extension.ui", 4, panelPayload)).state
    state = applyPiEvent(state, baseEvent("extension.ui", 5, { id: "subagents", removed: true })).state
    expect(state.bySession.get("sess-1")!.extensionPanels.has("subagents")).toBe(false)
  })

  test("apps register with html and unregister on removal or empty html", () => {
    let state = applyPiEvent(createReducerState(), baseEvent("extension.app", 1, {
      appId: "board",
      title: "Board",
      html: "<button data-pichamber-command=\"run\">Run</button>",
    })).state
    expect(state.bySession.get("sess-1")!.extensionApps.get("board")?.html).toContain("data-pichamber-command")

    state = applyPiEvent(state, baseEvent("extension.app", 2, { appId: "board", removed: true })).state
    expect(state.bySession.get("sess-1")!.extensionApps.has("board")).toBe(false)

    state = applyPiEvent(state, baseEvent("extension.app", 3, { appId: "board", html: "<b>x</b>" })).state
    state = applyPiEvent(state, baseEvent("extension.app", 4, { appId: "board" })).state
    expect(state.bySession.get("sess-1")!.extensionApps.has("board")).toBe(false)
  })

  test("snapshot replaces panel and app maps and replays pending form dialogs", () => {
    let state = createReducerState()
    state = applyPiEvent(state, baseEvent("session.snapshot", 20, {
      snapshot: {
        sessionId: "sess-1",
        directory: "/work",
        isStreaming: false,
        lifecycle: "idle",
        queue: { steering: 0, followUp: 0 },
        lastSequence: 20,
        extensionPanels: [panelPayload],
        extensionApps: [{ appId: "board", title: "Board", html: "<p>b</p>" }],
        extensionDialogs: [{
          requestId: "form-1",
          method: "form",
          title: "Spawn agent",
          fields: [
            { id: "name", label: "Name", type: "text", required: true },
            { id: "level", label: "Level", type: "select", options: ["low", "high"] },
          ],
        }],
      },
    } as never)).state
    const session = state.bySession.get("sess-1")!
    expect([...session.extensionPanels.keys()]).toEqual(["subagents"])
    expect([...session.extensionApps.keys()]).toEqual(["board"])
    expect(session.extensionDialogs[0]?.method).toBe("form")
    expect(session.extensionDialogs[0]?.fields).toHaveLength(2)
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
