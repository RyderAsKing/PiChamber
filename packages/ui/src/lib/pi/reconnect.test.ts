import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchPiRuntimeHealth: any = mock(async () => ({
  state: "ready",
  protocolVersion: 1,
  capabilities: [],
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

describe("reconnectPiSession", () => {
  beforeEach(() => {
    mockFetchPiRuntimeHealth.mockReset()
    mockCreatePiEventStream.mockReset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns unavailable when the daemon is down", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "unavailable",
      protocolVersion: 1,
      capabilities: [],
      error: { code: "DAEMON_UNAVAILABLE" },
    })
    const { reconnectPiSession } = await import("./reconnect")
    const result = await reconnectPiSession({
      directory: "/work",
      sessionId: "s1",
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("unavailable")
    expect(result.error?.code).toBe("DAEMON_UNAVAILABLE")
    expect(result.stream).toBeNull()
  })

  test("captures a snapshot and resumes from its sequence", async () => {
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
      if (url.pathname === "/api/pi/sessions/s1") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [],
          lastSequence: 12,
        })
      }
      return jsonResponse({}, { status: 500 })
    })
    const { reconnectPiSession } = await import("./reconnect")
    const result = await reconnectPiSession({
      directory: "/work",
      sessionId: "s1",
      lastKnownSequence: 5,
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("ready")
    expect(result.lastSequence).toBe(12)
    expect(result.stream).not.toBeNull()
    expect(mockCreatePiEventStream.mock.calls[0]?.[1]?.fromSequence).toBe(12)
    expect(mockCreatePiEventStream.mock.calls[0]?.[1]?.sessionId).toBe(undefined)
  })

  test("resumes from the client cursor when it is ahead of the snapshot sequence", async () => {
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
      if (url.pathname === "/api/pi/sessions/s1") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [],
          lastSequence: 12,
        })
      }
      return jsonResponse({}, { status: 500 })
    })
    const { reconnectPiSession } = await import("./reconnect")
    const result = await reconnectPiSession({
      directory: "/work",
      sessionId: "s1",
      lastKnownSequence: 40,
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("ready")
    expect(result.lastSequence).toBe(40)
    expect(mockCreatePiEventStream.mock.calls[0]?.[1]?.fromSequence).toBe(40)
    expect(mockCreatePiEventStream.mock.calls[0]?.[1]?.sessionId).toBe(undefined)
  })

  test("returns failed when the session is not indexed", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: [],
    })
    installFetchMock(() =>
      jsonResponse({ error: { code: "INVALID_SESSION" } }, { status: 404 }),
    )
    const { reconnectPiSession } = await import("./reconnect")
    const result = await reconnectPiSession({
      directory: "/work",
      sessionId: "missing",
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("failed")
    expect(result.error?.code).toBe("INVALID_SESSION")
  })
})
