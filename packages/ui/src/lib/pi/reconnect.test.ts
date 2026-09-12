import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchPiRuntimeHealth: any = mock(async () => ({
  state: "ready",
  protocolVersion: 1,
  capabilities: ["events.streamEpoch"],
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
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-test-1",
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
      if (url.pathname === "/api/pi/sessions/s1") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [],
          lastSequence: 12,
          streamEpoch: "epoch-test-1",
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

  test("hydrates a still-streaming session instead of fabricating idle", async () => {
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
      if (url.pathname === "/api/pi/sessions/s1") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [{
            message: {
              id: "m1", sessionId: "s1", directory: "/work", role: "assistant",
              text: "", thinking: "", createdAt: 1,
            },
            parts: [{
              id: "p1", index: 0, type: "tool", toolCallId: "tc-1", name: "bash",
              state: "running",
            }],
          }],
          lastSequence: 12,
          isStreaming: true,
          lifecycle: "busy",
          runStartedAt: 1_000,
          serverNow: 2_000,
          streamEpoch: "epoch-test-1",
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
    expect(result.snapshotState.bySession.get("s1")?.isStreaming).toBe(true)
    expect(result.snapshotState.bySession.get("s1")?.lifecycle).toBe("busy")
    const session = result.reducerState.bySession.get("s1")
    expect(session?.lifecycle).toBe("busy")
    expect(result.runStartedAt).toBe(1_000)
    expect(result.serverNow).toBe(2_000)
    expect(session?.streamingMessages.has("m1")).toBe(true)
    expect(session?.parts.get("p1")?.tool?.state).toBe("running")
  })

  test("resumes from the client cursor when it is ahead of the snapshot sequence", async () => {
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
      if (url.pathname === "/api/pi/sessions/s1") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [],
          lastSequence: 12,
          streamEpoch: "epoch-test-1",
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
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-test-1",
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

  test("fails visibly when the runtime does not advertise the stream-epoch capability", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: [],
    })
    const { reconnectPiSession } = await import("./reconnect")
    const result = await reconnectPiSession({
      directory: "/work",
      sessionId: "s1",
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("failed")
    expect(result.error?.code).toBe("DAEMON_PROTOCOL_MISMATCH")
    expect(result.stream).toBeNull()
  })

  test("a new daemon epoch uses the snapshot baseline even when the old cursor is numerically higher", async () => {
    // The restarted daemon's sequence space is unrelated: once its sequence
    // overtakes the old cursor, a blind max() would skip the head of the new
    // sequence space. The new baseline must be used verbatim.
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-new",
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
          streamEpoch: "epoch-new",
        })
      }
      return jsonResponse({}, { status: 500 })
    })
    const { reconnectPiSession } = await import("./reconnect")
    const result = await reconnectPiSession({
      directory: "/work",
      sessionId: "s1",
      lastKnownSequence: 40,
      streamEpoch: "epoch-old",
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("ready")
    expect(result.epoch).toBe("epoch-new")
    expect(result.epochChanged).toBe(true)
    expect(result.lastSequence).toBe(12)
    expect(mockCreatePiEventStream.mock.calls[0]?.[1]?.fromSequence).toBe(12)
    expect(mockCreatePiEventStream.mock.calls[0]?.[1]?.streamEpoch).toBe("epoch-new")
  })

  test("the same epoch keeps the client cursor when it is ahead of the snapshot", async () => {
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
      if (url.pathname === "/api/pi/sessions/s1") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [],
          lastSequence: 12,
          streamEpoch: "epoch-test-1",
        })
      }
      return jsonResponse({}, { status: 500 })
    })
    const { reconnectPiSession } = await import("./reconnect")
    const result = await reconnectPiSession({
      directory: "/work",
      sessionId: "s1",
      lastKnownSequence: 40,
      streamEpoch: "epoch-test-1",
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("ready")
    expect(result.epochChanged).toBeUndefined()
    expect(result.lastSequence).toBe(40)
    expect(mockCreatePiEventStream.mock.calls[0]?.[1]?.streamEpoch).toBe("epoch-test-1")
  })

  test("a session detail without the advertised stream epoch fails visibly", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-test-1",
    })
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
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("failed")
    expect(result.error?.code).toBe("DAEMON_PROTOCOL_MISMATCH")
    expect(result.stream).toBeNull()
  })

  test("a session detail stamped with a retired epoch is rejected", async () => {
    mockFetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-new",
    })
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions/s1") {
        return jsonResponse({
          session: { id: "s1", directory: "/work" },
          messages: [],
          lastSequence: 12,
          streamEpoch: "epoch-old",
        })
      }
      return jsonResponse({}, { status: 500 })
    })
    const { reconnectPiSession } = await import("./reconnect")
    const result = await reconnectPiSession({
      directory: "/work",
      sessionId: "s1",
      onEvent: () => {},
    }, dependencies)
    expect(result.phase).toBe("failed")
    expect(result.stream).toBeNull()
  })
})
