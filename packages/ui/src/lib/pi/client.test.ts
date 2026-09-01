import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { PiService, piClient, createScopedPiClient, PiRequestError } from "@/lib/pi/client"
import { fetchPiRuntimeHealth } from "./transport"

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
      if (url.pathname === "/api/pi/projects/select" && call.init?.method === "POST") {
        const body = JSON.parse((call.init?.body as string) ?? "{}") as { directory: string }
        return jsonResponse({ directory: body.directory })
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
      if (url.pathname === "/api/pi/sessions/s1/compact" && call.init?.method === "POST") {
        return jsonResponse({ accepted: true }, { status: 202 })
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("listProjects reads the public Pi project collection", async () => {
    const client = new PiService()
    expect(await client.listProjects()).toEqual({ projects: [{ directory: "/work", selected: true }] })
    expect(recordedCalls()[0].url).toBe("/api/pi/projects")
  })

  test("selectProject explicitly adopts the user-selected directory", async () => {
    const client = new PiService()
    expect(await client.selectProject("/chosen")).toEqual({ directory: "/chosen" })
    const call = recordedCalls()[0]
    expect(call.url).toBe("/api/pi/projects/select")
    expect(call.init?.method).toBe("POST")
    expect(JSON.parse(call.init?.body as string)).toEqual({ directory: "/chosen" })
  })

  test("compactSession acknowledges asynchronous compaction and forwards instructions", async () => {
    const client = new PiService()
    await client.compactSession({ sessionId: "s1", customInstructions: "Keep open test failures" })
    const call = recordedCalls()[0]
    expect(call.url).toBe("/api/pi/sessions/s1/compact")
    expect(call.init?.method).toBe("POST")
    expect(JSON.parse(call.init?.body as string)).toEqual({
      sessionId: "s1",
      customInstructions: "Keep open test failures",
    })
  })

  test("createSession POSTs to /api/pi/sessions", async () => {
    const client = new PiService()
    const result = await client.createSession({ cwd: "/work", title: "demo" })
    expect(result.session.id).toBe("s1")
    expect(recordedCalls()).toHaveLength(1)
    const call = recordedCalls()[0]
    expect(call.init?.method).toBe("POST")
    expect(JSON.parse(call.init?.body as string)).toEqual({ cwd: "/work", title: "demo" })
  })

  test("uploads raw attachment bytes with metadata and progress", async () => {
    const progress: number[] = []
    installFetchMock(async (call) => {
      expect(call.url).toBe("/api/pi/attachments")
      expect(call.init?.method).toBe("POST")
      const headers = new Headers(call.init?.headers)
      expect(headers.get("content-type")).toBe("application/octet-stream")
      expect(decodeURIComponent(headers.get("x-pichamber-filename") || "")).toBe("notes ü.txt")
      expect(headers.get("x-pichamber-mime")).toBe("text/plain")
      const body = call.init?.body as ReadableStream<Uint8Array>
      const bytes = new Uint8Array(await new Response(body).arrayBuffer())
      expect(new TextDecoder().decode(bytes)).toBe("hello")
      return jsonResponse({ attachment: { id: "a1", name: "notes_.txt", mime: "text/plain", size: 5, expiresAt: 10 } }, { status: 201 })
    })

    const attachment = await new PiService().uploadAttachment(
      new Blob(["hello"], { type: "text/plain" }),
      { filename: "notes ü.txt", mime: "text/plain", onProgress: ({ loaded }) => progress.push(loaded) },
    )
    expect(attachment.id).toBe("a1")
    expect([0, 5]).toContain(progress.at(-1))
  })

  test("deleteSession returns true on 204 and 404", async () => {
    const client = new PiService()
    expect(await client.deleteSession({ sessionId: "s1" })).toBe(true)
    installFetchMock(() => jsonResponse({ error: { code: "INVALID_SESSION" } }, { status: 404 }))
    expect(await client.deleteSession({ sessionId: "s1" })).toBe(true)
  })

  test("listSessions retries transient 503 DAEMON_UNAVAILABLE and succeeds on second attempt", async () => {
    let attempt = 0;
    installFetchMock(() => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse({ error: { code: "DAEMON_UNAVAILABLE" } }, { status: 503 });
      }
      return jsonResponse({ sessions: [{ session: { id: "s1", directory: "/repo" } }] });
    });
    const client = new PiService();
    const result = await client.listSessions();
    expect(result.sessions).toHaveLength(1);
    expect(attempt).toBe(2);
  });

  test("listSessions throws PiRequestError on persistent 5xx response", async () => {
    installFetchMock(() =>
      jsonResponse({ error: { code: "DAEMON_UNAVAILABLE" } }, { status: 503 }),
    )
    const client = new PiService()
    try {
      await client.listSessions()
      throw new Error("expected listSessions to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiRequestError)
    }
  })

  test("forwards provider login input once and exposes only public login state", async () => {
    installFetchMock((call) => {
      expect(call.url).toBe("/api/pi/providers/p1/login")
      expect(call.init?.method).toBe("POST")
      expect(JSON.parse(call.init?.body as string)).toEqual({ providerId: "p1", type: "api_key", apiKey: "private-key" })
      return jsonResponse({ login: { id: "login-1", providerId: "p1", state: "pending" } })
    })
    const client = new PiService()
    expect(await client.loginProvider({ providerId: "p1", type: "api_key", apiKey: "private-key" })).toEqual({
      login: { id: "login-1", providerId: "p1", state: "pending" },
    })
  })

  test("reads and writes custom provider models without treating write-only headers as response data", async () => {
    installFetchMock((call) => {
      expect(call.url).toBe("/api/pi/providers/custom/models")
      expect(call.init?.method).toBe("PUT")
      expect(JSON.parse(call.init?.body as string)).toEqual({ providerId: "custom", label: "Custom", baseUrl: "https://api.example.test/v1", api: "openai-completions", headers: { "X-Client": "private" }, models: [{ id: "model", providerId: "custom", label: "Model" }] })
      return jsonResponse({ config: { providerId: "custom", label: "Custom", baseUrl: "https://api.example.test/v1", api: "openai-completions", models: [{ id: "model", providerId: "custom", label: "Model" }] } })
    })
    expect(await new PiService().setProviderModels({ providerId: "custom", label: "Custom", baseUrl: "https://api.example.test/v1", api: "openai-completions", headers: { "X-Client": "private" }, models: [{ id: "model", providerId: "custom", label: "Model" }] })).toEqual({
      config: { providerId: "custom", label: "Custom", baseUrl: "https://api.example.test/v1", api: "openai-completions", models: [{ id: "model", providerId: "custom", label: "Model" }] },
    })
  })

  test("reads and writes separated Pi and PiChamber settings", async () => {
    installFetchMock((call) => {
      if (call.url === "/api/pi/settings" && call.init?.method === "GET") {
        return jsonResponse({ pi: { global: {}, project: { trusted: false } }, pichamber: { version: 1 } })
      }
      if (call.url === "/api/pi/settings/defaults" && call.init?.method === "PUT") {
        return jsonResponse({ pichamber: { version: 1, defaultThinking: "high" } })
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })
    const client = new PiService()
    expect(await client.getSettings()).toEqual({ pi: { global: {}, project: { trusted: false } }, pichamber: { version: 1 } })
    expect(await client.setPiChamberDefaults({ defaultThinking: "high" })).toEqual({ pichamber: { version: 1, defaultThinking: "high" } })
  })

  test("uses the typed native resource routes", async () => {
    installFetchMock((call) => {
      if (call.url === "/api/pi/resources" && call.init?.method === "GET") {
        return jsonResponse({ skills: [], prompts: [], agents: [] })
      }
      if (call.url === "/api/pi/resources/prompt-1" && call.init?.method === "PUT") {
        expect(JSON.parse(call.init.body as string)).toEqual({ resourceId: "prompt-1", content: "Updated" })
        return jsonResponse({ skills: [], prompts: [], agents: [] })
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })
    const client = new PiService()
    expect(await client.listResources()).toEqual({ skills: [], prompts: [], agents: [] })
    expect(await client.updateResource({ resourceId: "prompt-1", content: "Updated" })).toEqual({ skills: [], prompts: [], agents: [] })
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
    const client = new PiService()
    const providers = await client.listProviders()
    expect(providers.providers).toHaveLength(1)
    expect(providers.default).toEqual({ providerId: "p1", modelId: "m1" })
  })
})

describe("fetchPiRuntimeHealth", () => {
  afterEach(() => { globalThis.fetch = originalFetch })

  test("returns ready when the daemon is up", async () => {
    installFetchMock(() => jsonResponse({ state: "ready", protocolVersion: 1, capabilities: [] }))
    expect((await fetchPiRuntimeHealth()).state).toBe("ready")
  })

  test("returns unavailable on 401", async () => {
    installFetchMock(() => jsonResponse({}, { status: 401 }))
    const health = await fetchPiRuntimeHealth()
    expect(health.state).toBe("unavailable")
    expect(health.error?.code).toBe("DAEMON_AUTH_FAILED")
  })

  test("returns unavailable on protocol mismatch", async () => {
    installFetchMock(() => new Response("not-json", { status: 200 }))
    const health = await fetchPiRuntimeHealth()
    expect(health.state).toBe("unavailable")
    expect(health.error?.code).toBe("DAEMON_PROTOCOL_MISMATCH")
  })
})

describe("module exports", () => {
  test("piClient is a PiService instance", async () => {
    expect(piClient).toBeInstanceOf(PiService)
  })

  test("createScopedPiClient binds the directory", async () => {
    const scoped = createScopedPiClient("/scoped")
    expect(scoped).toBeInstanceOf(PiService)
    expect(scoped.getDirectory()).toBe("/scoped")
  })
})
