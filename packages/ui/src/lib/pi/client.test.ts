import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { PiService, piClient, createScopedPiClient, PiRequestError, PiSendUnconfirmedError } from "@/lib/pi/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { fetchPiRuntimeHealth, observePiStreamEpoch } from "./transport"

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
    observePiStreamEpoch(getRuntimeKey(), "epoch-client")
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

  test("health preserves the restart-safe stream epoch", async () => {
    installFetchMock(() => jsonResponse({
      protocolVersion: 1,
      state: "ready",
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-client-health",
    }))

    expect(await new PiService().health()).toEqual({
      protocolVersion: 1,
      state: "ready",
      capabilities: ["events.streamEpoch"],
      streamEpoch: "epoch-client-health",
    })
  })

  test("getSessionMessages forwards the page cursor, limit, and owning directory", async () => {
    installFetchMock(() => jsonResponse({
      session: { id: "s1", directory: "/other", createdAt: 1, updatedAt: 2 },
      messages: [],
      hasMoreBefore: false,
      lastSequence: 3,
      isStreaming: false,
      lifecycle: "idle",
    }))
    const result = await new PiService().getSessionMessages(
      "s1",
      { before: "entry-5", limit: 25 },
      { directory: "/other" },
    )
    expect(result.hasMoreBefore).toBe(false)
    expect(recordedCalls()[0].url).toBe("/api/pi/sessions/s1/messages?directory=%2Fother&before=entry-5&limit=25")
    expect(recordedCalls()[0].init?.method).toBe("GET")
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

  test("deleteSession forwards owning directory as query", async () => {
    installFetchMock(() => new Response(null, { status: 204 }))
    const client = new PiService()
    expect(await client.deleteSession({ sessionId: "s1" }, { directory: "/other" })).toBe(true)
    expect(recordedCalls()[0].url).toBe("/api/pi/sessions/s1?directory=%2Fother")
  })

  test("archiveSession sends owning directory in body", async () => {
    installFetchMock((call) => {
      expect(call.url).toBe("/api/pi/sessions/s1/archive")
      expect(JSON.parse(call.init?.body as string)).toEqual({ sessionId: "s1", archived: true, directory: "/other" })
      return new Response(null, { status: 204 })
    })
    const client = new PiService()
    await client.archiveSession({ sessionId: "s1", archived: true }, { directory: "/other" })
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

  test("uses the PiChamber snippet and native command routes", async () => {
    installFetchMock((call) => {
      if (call.url.startsWith("/api/pi/snippets") && call.init?.method === "GET") {
        return jsonResponse({ snippets: [{ id: "s1", name: "note", content: "Content", aliases: [], scope: "global" }] })
      }
      if (call.url === "/api/pi/snippets" && call.init?.method === "POST") {
        const body = JSON.parse(call.init.body as string) as { name: string; scope: string }
        expect(body.name).toBe("note")
        expect(body.scope).toBe("global")
        return jsonResponse({ snippets: [] }, { status: 201 })
      }
      if (call.url.startsWith("/api/pi/commands")) {
        return jsonResponse({ directory: "/work", commands: [{ name: "review", source: "prompt" }] })
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })
    const client = new PiService()
    expect(await client.listSnippets("/work")).toEqual({ snippets: [{ id: "s1", name: "note", content: "Content", aliases: [], scope: "global" }] })
    expect(await client.listCommands("/work")).toEqual({ directory: "/work", commands: [{ name: "review", source: "prompt" }] })
  })

  test("uses explicit directories for prompt template mutations", async () => {
    installFetchMock((call) => {
      if (call.url.startsWith("/api/pi/resources/prompts") && call.init?.method === "POST") {
        if (!call.url.includes("directory=%2Fwork")) throw new Error("missing directory");
        return jsonResponse({ skills: [], prompts: [], agents: [] }, { status: 201 });
      }
      if (call.url.startsWith("/api/pi/resources/prompts/prompt-1") && call.init?.method === "PUT") {
        if (!call.url.includes("directory=%2Fwork")) throw new Error("missing directory");
        const body = JSON.parse(call.init.body as string) as { name?: string };
        expect(body.name).toBe("review2");
        return jsonResponse({ skills: [], prompts: [], agents: [] });
      }
      if (call.url.startsWith("/api/pi/resources/prompts/prompt-1") && call.init?.method === "DELETE") {
        if (!call.url.includes("directory=%2Fwork")) throw new Error("missing directory");
        return jsonResponse({ skills: [], prompts: [], agents: [] });
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 });
    });
    const client = new PiService();
    expect(
      await client.createPromptTemplate({ name: "review", description: "Review", content: "Do $1", location: "global" }, "/work"),
    ).toEqual({ skills: [], prompts: [], agents: [] });
    expect(await client.updatePromptTemplate("prompt-1", { name: "review2" }, "/work")).toEqual({
      skills: [],
      prompts: [],
      agents: [],
    });
    expect(await client.deletePromptTemplate("prompt-1", "/work")).toEqual({ skills: [], prompts: [], agents: [] });
  });

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

describe("send retry safety", () => {
  beforeEach(() => {
    observePiStreamEpoch(getRuntimeKey(), "epoch-client")
  })

  test("a lost reply is attempted exactly once and throws PiSendUnconfirmedError", async () => {
    installFetchMock(() => {
      throw new TypeError("network down")
    })
    const client = new PiService()
    try {
      await client.sendPrompt({ sessionId: "s1", text: "hello" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
      expect((error as PiSendUnconfirmedError).cause).toBeInstanceOf(TypeError)
    }
    expect(recordedCalls()).toHaveLength(1)
    expect(recordedCalls()[0].url).toBe("/api/pi/sessions/s1/prompt")
  })

  test("prompt/steer/followUp never retry network loss", async () => {
    installFetchMock(() => {
      throw new TypeError("network down")
    })
    const client = new PiService()
    for (const send of [
      () => client.sendPrompt({ sessionId: "s1", text: "a" }),
      () => client.sendSteer({ sessionId: "s1", text: "b" }),
      () => client.sendFollowUp({ sessionId: "s1", text: "c" }),
    ]) {
      try {
        await send()
        throw new Error("expected send to throw")
      } catch (error) {
        expect(error).toBeInstanceOf(PiSendUnconfirmedError)
      }
    }
    expect(recordedCalls()).toHaveLength(3)
    expect(recordedCalls().map((call) => call.url)).toEqual([
      "/api/pi/sessions/s1/prompt",
      "/api/pi/sessions/s1/steer",
      "/api/pi/sessions/s1/follow-up",
    ])
  })

  test("sends do not retry DAEMON_TIMEOUT 503", async () => {
    installFetchMock(() => jsonResponse({ error: { code: "DAEMON_TIMEOUT" } }, { status: 503 }))
    const client = new PiService()
    try {
      await client.sendPrompt({ sessionId: "s1", text: "hello" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
      expect((error as PiSendUnconfirmedError).code).toBe("DAEMON_TIMEOUT")
    }
    expect(recordedCalls()).toHaveLength(1)
  })

  test("non-send POSTs keep the existing transient retry", async () => {
    let attempt = 0
    installFetchMock(() => {
      attempt += 1
      if (attempt === 1) {
        return jsonResponse({ error: { code: "DAEMON_UNAVAILABLE" } }, { status: 503 })
      }
      return jsonResponse({ directory: "/work" })
    })
    const client = new PiService()
    expect(await client.selectProject("/work")).toEqual({ directory: "/work" })
    expect(attempt).toBe(2)
  })

  test("definite 4xx stays PiRequestError without receipt lookup or retry", async () => {
    installFetchMock(() => jsonResponse({ error: { code: "INVALID_PROMPT" } }, { status: 400 }))
    const client = new PiService()
    try {
      await client.sendPrompt({ sessionId: "s1", text: "bad", operationId: "op-1" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiRequestError)
      expect(error instanceof PiSendUnconfirmedError).toBe(false)
    }
    expect(recordedCalls()).toHaveLength(1)
  })

  test("operation payload mismatch stays definite", async () => {
    installFetchMock(() => jsonResponse({ error: { code: "OPERATION_PAYLOAD_MISMATCH" } }, { status: 409 }))
    const client = new PiService()
    try {
      await client.sendPrompt({ sessionId: "s1", text: "other", operationId: "op-1" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiRequestError)
      expect((error as PiRequestError).status).toBe(409)
    }
    expect(recordedCalls()).toHaveLength(1)
  })

  test("stale stream epochs hold without replay or cross-epoch receipt lookup", async () => {
    installFetchMock((call) => {
      expect(JSON.parse(call.init?.body as string)).toMatchObject({ streamEpoch: "epoch-client" })
      return jsonResponse({ error: { code: "STALE_STREAM_EPOCH" } }, { status: 409 })
    })
    try {
      await new PiService().sendPrompt({ sessionId: "s1", text: "hello", operationId: "op-stale" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
      expect((error as PiSendUnconfirmedError).code).toBe("STALE_STREAM_EPOCH")
    }
    expect(recordedCalls()).toHaveLength(1)
  })

  test("408 and operation expiry are unconfirmed, not definite", async () => {
    installFetchMock(() => jsonResponse({ error: { code: "DAEMON_TIMEOUT" } }, { status: 408 }))
    try {
      await new PiService().sendPrompt({ sessionId: "s1", text: "hello" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
    }
    expect(recordedCalls()).toHaveLength(1)
    installFetchMock(() => jsonResponse({ error: { code: "OPERATION_EXPIRED" } }, { status: 410 }))
    try {
      await new PiService().sendPrompt({ sessionId: "s1", text: "hello", operationId: "op-old" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      // Expired retention means the outcome is unknown. The receipt lookup
      // for the same expired id returns expired, so the original failure is
      // preserved as unconfirmed instead of a definite rejection.
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
    }
  })

  test("accepted receipt recovers a lost reply without replay", async () => {
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions/s1/prompt") {
        throw new TypeError("reply lost")
      }
      if (url.pathname === "/api/pi/sessions/s1/send-receipt") {
        const body = JSON.parse(call.init?.body as string) as { kind?: unknown; operationId?: unknown }
        expect(body).toEqual({ kind: "prompt", operationId: "op-1", streamEpoch: "epoch-client" })
        return jsonResponse({ status: "accepted", receipt: { accepted: true, messageId: "m-1" } })
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })
    const result = await new PiService().sendPrompt({ sessionId: "s1", text: "hello", operationId: "op-1" })
    expect(result).toEqual({ accepted: true, messageId: "m-1" })
    expect(recordedCalls()).toHaveLength(2)
    expect(recordedCalls().filter((call) => call.url === "/api/pi/sessions/s1/prompt")).toHaveLength(1)
    expect(recordedCalls()[1].url).toBe("/api/pi/sessions/s1/send-receipt")
  })

  test("unknown/expired/pending never replay and preserve the original error", async () => {
    for (const status of ["unknown", "expired", "pending"] as const) {
      installFetchMock((call) => {
        const url = new URL(call.url, "http://localhost")
        if (url.pathname === "/api/pi/sessions/s1/prompt") {
          throw new TypeError(`lost-${status}`)
        }
        if (url.pathname === "/api/pi/sessions/s1/send-receipt") {
          return jsonResponse({ status })
        }
        return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
      })
      try {
        await new PiService().sendPrompt({ sessionId: "s1", text: "hello", operationId: `op-${status}` })
        throw new Error(`expected ${status} to throw`)
      } catch (error) {
        expect(error).toBeInstanceOf(PiSendUnconfirmedError)
        expect((error as PiSendUnconfirmedError).cause).toBeInstanceOf(TypeError)
      }
      expect(recordedCalls().filter((call) => call.url === "/api/pi/sessions/s1/prompt")).toHaveLength(1)
      expect(recordedCalls()).toHaveLength(2)
    }
  })

  test("a failed receipt lookup preserves the original send error", async () => {
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions/s1/prompt") {
        throw new TypeError("lost reply")
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })
    try {
      await new PiService().sendPrompt({ sessionId: "s1", text: "hello", operationId: "op-1" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
      expect((error as PiSendUnconfirmedError).cause).toBeInstanceOf(TypeError)
    }
    expect(recordedCalls()).toHaveLength(2)
  })

  test("malformed accepted responses are never treated as success", async () => {
    installFetchMock(() => jsonResponse({ accepted: true }))
    try {
      await new PiService().sendPrompt({ sessionId: "s1", text: "hello" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
    }
    expect(recordedCalls()).toHaveLength(1)
  })

  test("malformed accepted receipt does not recover", async () => {
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions/s1/prompt") {
        throw new TypeError("lost")
      }
      return jsonResponse({ status: "accepted", receipt: { accepted: true } })
    })
    try {
      await new PiService().sendPrompt({ sessionId: "s1", text: "hello", operationId: "op-1" })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
    }
    expect(recordedCalls()).toHaveLength(2)
  })

  test("sends and receipt lookups forward the directory scope", async () => {
    installFetchMock((call) => {
      const url = new URL(call.url, "http://localhost")
      if (url.pathname === "/api/pi/sessions/s1/prompt") {
        expect(url.searchParams.get("directory")).toBe("/other")
        return jsonResponse({ accepted: true, messageId: "m-1" }, { status: 202 })
      }
      if (url.pathname === "/api/pi/sessions/s1/send-receipt") {
        expect(url.searchParams.get("directory")).toBe("/other")
        const body = JSON.parse(call.init?.body as string) as Record<string, unknown>
        expect(body).toEqual({ kind: "steer", operationId: "op-1", streamEpoch: "epoch-client" })
        return jsonResponse({ status: "unknown" })
      }
      return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 })
    })
    const client = new PiService()
    expect(await client.sendPrompt({ sessionId: "s1", text: "hello" }, { directory: "/other" })).toEqual({
      accepted: true,
      messageId: "m-1",
    })
    expect(await client.getSendReceipt({ sessionId: "s1", kind: "steer", operationId: "op-1" }, { directory: "/other" })).toEqual({
      status: "unknown",
    })
    expect(recordedCalls()[0].url).toBe("/api/pi/sessions/s1/prompt?directory=%2Fother")
    expect(recordedCalls()[1].url).toBe("/api/pi/sessions/s1/send-receipt?directory=%2Fother")
  })

  test("stale runtime keys reject without network use", async () => {
    const current = getRuntimeKey()
    const stale = `${current}::stale`
    installFetchMock(() => jsonResponse({ accepted: true, messageId: "m-1" }))
    try {
      await new PiService().sendPrompt({ sessionId: "s1", text: "hello" }, { runtimeKey: stale })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
    }
    try {
      await new PiService().getSendReceipt({ sessionId: "s1", kind: "prompt", operationId: "op-1" }, { runtimeKey: stale })
      throw new Error("expected getSendReceipt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiRequestError)
    }
    expect(recordedCalls()).toHaveLength(0)
  })

  test("a runtime switch during the send leaves the outcome unconfirmed", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window
    const current = getRuntimeKey()
    installFetchMock(() => {
      ;(globalThis as Record<string, unknown>).window = {
        __PICHAMBER_API_BASE_URL__: "https://switched.example.test",
      }
      return jsonResponse({ accepted: true, messageId: "m-1" })
    })
    try {
      await new PiService().sendPrompt({ sessionId: "s1", text: "hello" }, { runtimeKey: current })
      throw new Error("expected sendPrompt to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PiSendUnconfirmedError)
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window
      } else {
        ;(globalThis as Record<string, unknown>).window = originalWindow
      }
    }
    expect(recordedCalls()).toHaveLength(1)
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
