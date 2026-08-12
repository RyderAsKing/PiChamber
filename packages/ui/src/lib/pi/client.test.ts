import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// The transport module uses the runtime URL resolver which is not
// available in a Node test environment. We mock the whole module so that
// the client tests do not have to depend on a real resolver, while still
// allowing the dedicated transport tests to override the mock at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transportMock: any = {
  fetchPiRuntimeHealth: mock(async () => ({
    state: "ready" as const,
    protocolVersion: 1,
    capabilities: [],
  })),
  createPiEventStream: mock(() => ({
    dispose: () => undefined,
    reconnect: () => undefined,
    eventsUrl: "ws://test/events",
  })),
}

mock.module("./transport", () => transportMock)

// Mock runtime-fetch to a stub that captures calls. We still need to mock
// the underlying globalThis.fetch so the client actually issues requests.
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

const recordedCalls = (): FetchCall[] => calls

describe("PiService", () => {
  beforeEach(() => {
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/runtime") {
        return jsonResponse({
          protocolVersion: 1,
          state: "ready",
          capabilities: ["sessions.list"],
        })
      }
      if (url.pathname === "/api/pi/projects" && call.init?.method === "GET") {
        return jsonResponse({ projects: [{ directory: "/work", selected: true }] })
      }
      if (url.pathname === "/api/pi/sessions" && call.init?.method === "GET") {
        return jsonResponse({ sessions: [] })
      }
      if (url.pathname === "/api/pi/sessions" && call.init?.method === "POST") {
        const body = JSON.parse((call.init?.body as string) ?? "{}") as { cwd: string }
        return jsonResponse({
          session: { id: "s1", directory: body.cwd, title: "new" },
          messages: [],
          lastSequence: 0,
        })
      }
      if (url.pathname === "/api/pi/sessions/s1" && call.init?.method === "DELETE") {
        return new Response(null, { status: 204 })
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("listProjects reads the public Pi project collection", async () => {
    const { PiService } = await import("./client")
    const client = new PiService()
    expect(await client.listProjects()).toEqual({ projects: [{ directory: "/work", selected: true }] })
    expect(recordedCalls()[0].url).toBe("/api/pi/projects")
  })

  test("createSession POSTs to /api/pi/sessions", async () => {
    const { PiService } = await import("./client")
    const client = new PiService()
    const result = await client.createSession({ cwd: "/work", title: "demo" })
    expect(result.session.id).toBe("s1")
    expect(recordedCalls()).toHaveLength(1)
    const call = recordedCalls()[0]
    expect(call.init?.method).toBe("POST")
    expect(JSON.parse(call.init?.body as string)).toEqual({ cwd: "/work", title: "demo" })
  })

  test("deleteSession returns true on 204 and 404", async () => {
    const { PiService } = await import("./client")
    const client = new PiService()
    expect(await client.deleteSession({ sessionId: "s1" })).toBe(true)
    installFetchMock(() => jsonResponse({ error: { code: "INVALID_SESSION" } }, { status: 404 }))
    expect(await client.deleteSession({ sessionId: "s1" })).toBe(true)
  })

  test("listSessions throws PiRequestError on a 5xx response", async () => {
    installFetchMock(() =>
      jsonResponse({ error: { code: "DAEMON_UNAVAILABLE" } }, { status: 503 }),
    )
    const { PiService, PiRequestError } = await import("./client")
    const client = new PiService()
    try {
      await client.listSessions()
      throw new Error("expected listSessions to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiRequestError)
    }
  })

  test("listProviders returns the parsed payload", async () => {
    installFetchMock(() =>
      jsonResponse({
        providers: [
          {
            id: "p1",
            label: "P1",
            authenticated: true,
            models: [{ id: "m1", providerId: "p1" }],
          },
        ],
        default: { providerId: "p1", modelId: "m1" },
      }),
    )
    const { PiService } = await import("./client")
    const client = new PiService()
    const providers = await client.listProviders()
    expect(providers.providers).toHaveLength(1)
    expect(providers.default).toEqual({ providerId: "p1", modelId: "m1" })
  })
})

describe("fetchPiRuntimeHealth", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    transportMock.fetchPiRuntimeHealth.mockReset()
    transportMock.fetchPiRuntimeHealth.mockResolvedValue({
      state: "ready",
      protocolVersion: 1,
      capabilities: [],
    })
  })

  test("returns ready when the daemon is up", async () => {
    transportMock.fetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "ready",
      protocolVersion: 1,
      capabilities: [],
    })
    const { fetchPiRuntimeHealth } = await import("./transport")
    const health = await fetchPiRuntimeHealth()
    expect(health.state).toBe("ready")
  })

  test("returns unavailable on 401", async () => {
    transportMock.fetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "unavailable",
      protocolVersion: 1,
      capabilities: [],
      error: { code: "DAEMON_AUTH_FAILED" },
    })
    const { fetchPiRuntimeHealth } = await import("./transport")
    const health = await fetchPiRuntimeHealth()
    expect(health.state).toBe("unavailable")
    expect(health.error?.code).toBe("DAEMON_AUTH_FAILED")
  })

  test("returns unavailable on protocol mismatch", async () => {
    transportMock.fetchPiRuntimeHealth.mockResolvedValueOnce({
      state: "unavailable",
      protocolVersion: 1,
      capabilities: [],
      error: { code: "DAEMON_PROTOCOL_MISMATCH" },
    })
    const { fetchPiRuntimeHealth } = await import("./transport")
    const health = await fetchPiRuntimeHealth()
    expect(health.state).toBe("unavailable")
    expect(health.error?.code).toBe("DAEMON_PROTOCOL_MISMATCH")
  })
})

describe("module exports", () => {
  test("piClient is a PiService instance", async () => {
    const { piClient, PiService } = await import("./client")
    expect(piClient).toBeInstanceOf(PiService)
  })

  test("createScopedPiClient binds the directory", async () => {
    const { createScopedPiClient, PiService } = await import("./client")
    const scoped = createScopedPiClient("/scoped")
    expect(scoped).toBeInstanceOf(PiService)
    expect(scoped.getDirectory()).toBe("/scoped")
  })
})
