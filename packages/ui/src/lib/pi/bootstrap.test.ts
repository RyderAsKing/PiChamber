import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchPiRuntimeHealth: any = mock(async () => ({
  state: "ready" as const,
  protocolVersion: 1,
  capabilities: ["sessions.list"],
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
      capabilities: [],
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
      capabilities: ["sessions.list"],
    })
    mockCreatePiEventStream.mockReturnValueOnce({
      dispose: () => undefined,
      reconnect: () => undefined,
      eventsUrl: "ws://test/events",
    } as never)
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions" && call.init?.method === "GET") {
        return jsonResponse({
          sessions: [{ session: { id: "s1", directory: "/work" }, updatedAt: 1_000 }],
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
    expect(result.stream).not.toBeNull()
    expect(result.errors).toHaveLength(0)
  })

  test("records session-list failures without aborting bootstrap", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: [],
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
