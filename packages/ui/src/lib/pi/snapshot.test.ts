import { describe, expect, test } from "bun:test"
import {
  applySnapshot,
  createSnapshotReducerState,
  projectSnapshot,
  resetSnapshot,
} from "./snapshot"
import type { PiSessionSnapshot } from "./types"

const snapshot = (
  sessionId: string,
  lastSequence: number,
  directory = "/work",
  extras: Partial<PiSessionSnapshot> = {},
): PiSessionSnapshot => ({
  sessionId,
  directory,
  lastSequence,
  isStreaming: false,
  lifecycle: "idle",
  ...extras,
})

describe("applySnapshot", () => {
  test("accepts strictly newer snapshots", () => {
    const state = createSnapshotReducerState()
    const first = applySnapshot(state, snapshot("s1", 5))
    expect(first.didUpdate).toBe(true)
    const second = applySnapshot(first.state, snapshot("s1", 5))
    expect(second.didUpdate).toBe(false)
    const third = applySnapshot(second.state, snapshot("s1", 6))
    expect(third.didUpdate).toBe(true)
  })

  test("rejects older snapshots without mutating references", () => {
    const state = createSnapshotReducerState()
    const first = applySnapshot(state, snapshot("s1", 5))
    const second = applySnapshot(first.state, snapshot("s1", 3))
    expect(second.didUpdate).toBe(false)
    expect(second.state).toBe(first.state)
  })

  test("tracks multiple sessions independently", () => {
    const state = createSnapshotReducerState()
    const a = applySnapshot(state, snapshot("a", 1))
    const b = applySnapshot(a.state, snapshot("b", 10))
    expect(b.state.bySession.size).toBe(2)
    expect(b.state.lastSequence.get("a")).toBe(1)
    expect(b.state.lastSequence.get("b")).toBe(10)
  })
})

describe("resetSnapshot", () => {
  test("removes the session from both maps", () => {
    const state = createSnapshotReducerState()
    const seeded = applySnapshot(state, snapshot("s1", 5))
    const cleared = resetSnapshot(seeded.state, "s1")
    expect(cleared.bySession.has("s1")).toBe(false)
    expect(cleared.lastSequence.has("s1")).toBe(false)
  })

  test("returns the same reference when nothing to clear", () => {
    const state = createSnapshotReducerState()
    const cleared = resetSnapshot(state, "missing")
    expect(cleared).toBe(state)
  })
})

describe("projectSnapshot", () => {
  test("copies the stable projection shape", () => {
    const projected = projectSnapshot(
      snapshot("s1", 7, "/repo", { isStreaming: true, lifecycle: "busy", lastText: "Hi" }),
    )
    expect(projected.lastSequence).toBe(7)
    expect(projected.isStreaming).toBe(true)
    expect(projected.lifecycle).toBe("busy")
    expect(projected.lastText).toBe("Hi")
  })
})
