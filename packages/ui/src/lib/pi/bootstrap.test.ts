import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchPiRuntimeHealth: any = mock(async () => ({
  state: "ready" as const,
  protocolVersion: 1,
  capabilities: ["sessions.list", "events.streamEpoch"],
  streamEpoch: "epoch-test-1",
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreatePiEventStream: any = mock(() => ({
  dispose: () => undefined,
  reconnect: () => undefined,
  eventsUrl: "ws://test/events",
}))

const dependencies = {
  fetchHealth: mockFetchPiRuntimeHealth,
  createStream: mockCreatePiEventStream,
}

const originalFetch = globalThis.fetch

type FetchCall = { url: string; init?: RequestInit }
const calls: FetchCall[] = []

const installFetchMock = (responder: (call: FetchCall) => Response | Promise<Response>) => {
  calls.length = 0
  const fn = mock(async (url: string, init?: RequestInit) => {
    const call: FetchCall = { url, init }
    calls.push(call)
    return responder(call)
  })
  globalThis.fetch = fn as unknown as typeof fetch
}

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
  const status = init.status ?? 200
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("bootstrapPiDirectory", () => {
  beforeEach(() => {
    mockFetchPiRuntimeHealth.mockReset()
    mockCreatePiEventStream.mockReset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns failed with DAEMON_UNAVAILABLE when the runtime is down", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "unavailable",
      protocolVersion: 1,
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-test-1",
      error: { code: "DAEMON_UNAVAILABLE" },
    })
    // Re-import to pick up the freshly-reset mock.
    const { bootstrapPiDirectory } = await import("./bootstrap")
    const events: unknown[] = []
    const result = await bootstrapPiDirectory({
      directory: "/work",
      onEvent: (event) => events.push(event),
    }, dependencies)
    expect(result.phase).toBe("failed")
    expect(result.health.state).toBe("unavailable")
    expect(result.stream).toBeNull()
    expect(events).toHaveLength(0)
  })

  test("hydrates the selected session and attaches a stream", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: ["sessions.list", "events.streamEpoch"],
      streamEpoch: "epoch-test-1",
    })
    mockCreatePiEventStream.mockReturnValueOnce({
      dispose: () => undefined,
      reconnect: () => undefined,
      eventsUrl: "ws://test/events",
    } as never)
    const runStartedAt = Date.now() - 120_000
    const serverNow = Date.now()
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions" && call.init?.method === "GET") {
        return jsonResponse({
          sessions: [{ session: { id: "s1", directory: "/work" }, updatedAt: 1_000 }],
          streamEpoch: "epoch-test-1",
        })
      }
      if (url.pathname === "/api/pi/sessions/s1" && call.init?.method === "GET") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [
            {
              message: {
                id: "m1",
                sessionId: "s1",
                directory: "/work",
                role: "assistant",
                text: "Hi",
                thinking: "",
                createdAt: 1_000,
              },
              parts: [{ id: "p1", index: 0, type: "text", text: "Hi" }],
            },
          ],
          lastSequence: 3,
          isStreaming: true,
          lifecycle: "busy",
          runStartedAt,
          serverNow,
          streamEpoch: "epoch-test-1",
        })
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })

    const { bootstrapPiDirectory } = await import("./bootstrap")
    const events: unknown[] = []
    const result = await bootstrapPiDirectory({
      directory: "/work",
      selectedSessionId: "s1",
      onEvent: (event) => events.push(event),
    }, dependencies)
    expect(result.health.state).toBe("ready")
    expect(result.reducerState.bySession.get("s1")?.messages.get("m1")?.text).toBe("Hi")
    expect(result.lastSequence.get("s1")).toBe(3)
    expect(result.selectedSessionTiming).toEqual({
      sessionId: "s1",
      isStreaming: true,
      lifecycle: "busy",
      runStartedAt,
      serverNow,
    })
    expect(result.stream).not.toBeNull()
    expect(result.errors).toHaveLength(0)
  })

  test("reuses first-attach health and session-list results", async () => {
    mockCreatePiEventStream.mockReturnValueOnce({
      dispose: () => undefined,
      reconnect: () => undefined,
      eventsUrl: "ws://test/events",
    } as never)
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions/s1" && call.init?.method === "GET") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [],
          lastSequence: 4,
          streamEpoch: "epoch-test-1",
        })
      }
      return jsonResponse({ error: { code: "UNEXPECTED_REQUEST" } }, { status: 500 })
    })

    const { bootstrapPiDirectory } = await import("./bootstrap")
    const result = await bootstrapPiDirectory({
      directory: "/work",
      selectedSessionId: "s1",
      initialHealth: {
        state: "ready",
        protocolVersion: 1,
        capabilities: ["sessions.list", "events.streamEpoch"],
        streamEpoch: "epoch-test-1",
      },
      initialSessions: [{
        session: { id: "s1", directory: "/work", createdAt: 0, updatedAt: 1_000 },
        updatedAt: 1_000,
      }],
      onEvent: () => undefined,
    }, dependencies)

    expect(mockFetchPiRuntimeHealth.mock.calls).toEqual([])
    expect(calls.filter(({ url }) => new URL(url, "http://localhost").pathname === "/api/pi/sessions")).toHaveLength(0)
    expect(calls.filter(({ url }) => new URL(url, "http://localhost").pathname === "/api/pi/sessions/s1")).toHaveLength(1)
    expect(result.lastSequence.get("s1")).toBe(4)
    expect(result.errors).toHaveLength(0)
  })

  test("fails visibly when an epoch-capable runtime omits the session-list epoch", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-test-1",
    })
    installFetchMock(() => jsonResponse({ sessions: [] }))

    const { bootstrapPiDirectory } = await import("./bootstrap")
    const result = await bootstrapPiDirectory({
      directory: "/work",
      onEvent: () => undefined,
    }, dependencies)

    expect(result.phase).toBe("failed")
    expect((result.errors[0]?.error as { code?: string }).code).toBe("DAEMON_PROTOCOL_MISMATCH")
    expect(result.stream).toBeNull()
  })

  test("records session-list failures without aborting bootstrap", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-test-1",
    })
    mockCreatePiEventStream.mockReturnValueOnce({
      dispose: () => undefined,
      reconnect: () => undefined,
      eventsUrl: "ws://test/events",
    } as never)
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions" && call.init?.method === "GET") {
        return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 502 })
      }
      return jsonResponse({}, { status: 500 })
    })

    const { bootstrapPiDirectory } = await import("./bootstrap")
    const events: unknown[] = []
    const result = await bootstrapPiDirectory({
      directory: "/work",
      onEvent: (event) => events.push(event),
    }, dependencies)
    expect(result.phase).toBe("ready")
    expect(result.errors.some((entry) => entry.phase === "session-list")).toBe(true)
    expect(result.stream).not.toBeNull()
  })
})
