/* eslint-disable */
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@/lib/chat/types"

import { piClient } from "@/lib/pi/client"
import { useGlobalSessionsStore } from "./useGlobalSessionsStore"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const originalListSessions = piClient.listSessions

// The store now fetches every requested project directory through the Pi
// client and splits active/archived client-side. The mock serves one
// inclusive response per requested directory.
const piItem = (id: string, directory: string, archived?: number) => ({
  session: {
    id,
    directory,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...(archived !== undefined ? { archived: true, timeArchived: archived } : {}),
  },
  updatedAt: 1,
})

const session = (id: string, title = id, archived?: number): Session => ({
  id,
  title,
  time: { created: 1, updated: 1, ...(archived !== undefined ? { archived } : {}) },
} as Session)

const withDirectory = (value: Session, directory: string): Session => ({
  ...value,
  directory,
} as Session)

describe("global session mutation reconciliation", () => {
  beforeEach(() => {
    piClient.listSessions = originalListSessions
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  afterEach(() => {
    piClient.listSessions = originalListSessions
  })

  test("keeps a session created after a directory refresh starts", async () => {
    const request = deferred()
    piClient.listSessions = async () => ({ sessions: await request.promise })

    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().upsertSession(session("created"))

    request.resolve([])
    await refreshing

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(["created"])
  })

  test("does not resurrect a session deleted after a directory refresh starts", async () => {
    const request = deferred()
    piClient.listSessions = async () => ({ sessions: await request.promise })

    const stale = withDirectory(session("deleted"), "/source")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().removeSessions([stale.id])

    request.resolve([piItem(stale.id, "/source")])
    await refreshing

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([])
  })

  test("keeps an archive mutation newer than the directory response", async () => {
    const request = deferred()
    piClient.listSessions = async () => ({ sessions: await request.promise })

    const stale = withDirectory(session("archived"), "/source")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().archiveSessions([stale.id], 10)

    request.resolve([piItem(stale.id, "/source")])
    await refreshing

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
    expect(useGlobalSessionsStore.getState().archivedSessions[0]?.time.archived).toBe(10)
  })

  test("keeps a newer title when an older response finishes last", async () => {
    const request = deferred()
    piClient.listSessions = async () => ({ sessions: await request.promise })

    const stale = withDirectory(session("updated", "Old"), "/source")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().upsertSession(session("updated", "New"))

    request.resolve([piItem(stale.id, "/source")])
    await refreshing

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.title).toBe("New")
  })

  test("keeps commit-time state when a directory refresh fails", async () => {
    const request = deferred()
    piClient.listSessions = async () => ({ sessions: await request.promise })

    const stale = withDirectory(session("stale"), "/source")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().upsertSession(session("created"))

    request.reject(new Error("unavailable"))
    await refreshing

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id).sort()).toEqual(["created", "stale"])
  })

  test("splits a restored session into the active list", async () => {
    piClient.listSessions = async () => ({
      sessions: [
        piItem("active", "/source"),
        piItem("archived", "/source", 5),
        piItem("restored", "/source", 0),
      ],
    })

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(["restored", "active"])
    expect(useGlobalSessionsStore.getState().archivedSessions.map((item) => item.id)).toEqual(["archived"])
  })

  test("does not undo a move while refreshing the source directory", async () => {
    piClient.listSessions = async () => ({ sessions: [piItem("moved", "/source")] })

    const source = withDirectory(session("moved"), "/source")
    useGlobalSessionsStore.getState().applySnapshot([source], [])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().upsertSession(withDirectory(session("moved"), "/destination"))

    await refreshing

    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get("/source")).toBe(undefined)
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get("/destination")?.[0]?.id).toBe("moved")
  })

  test("keeps a restore mutation newer than the directory refresh", async () => {
    piClient.listSessions = async () => ({ sessions: [piItem("restored", "/source", 5)] })

    const archived = withDirectory(session("restored", "restored", 5), "/source")
    useGlobalSessionsStore.getState().applySnapshot([], [archived])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().upsertSession({
      ...archived,
      time: { ...archived.time, archived: 0 },
    })

    await refreshing

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(["restored"])
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([])
  })
})
