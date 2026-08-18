import { beforeEach, describe, expect, mock, test } from "bun:test"

// Bun's test mock declarations are intentionally untyped at this module boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runtimeFetch: any = mock()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refreshRuntimeUrlAuthToken: any = mock()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openRuntimeWebSocket: any = mock()
let runtimeKey = "runtime-a"
let capacitor = false
const streamUrls: Array<{ transport: "ws" | "sse"; query: Record<string, string> }> = []

mock.module("@/lib/runtime-fetch", () => ({ runtimeFetch }))
mock.module("@/lib/runtime-auth", () => ({ refreshRuntimeUrlAuthToken }))
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => runtimeKey }))
mock.module("@/lib/runtime-url", () => ({
  getRuntimeUrlResolver: () => ({
    websocket: (path: string, query: Record<string, string>) => {
      streamUrls.push({ transport: "ws", query })
      return `ws://runtime${path}`
    },
    sse: (path: string, query: Record<string, string>) => {
      streamUrls.push({ transport: "sse", query })
      return `http://runtime${path}`
    },
  }),
}))
mock.module("@/lib/relay/runtime-socket", () => ({ openRuntimeWebSocket }))
mock.module("@/lib/relay/runtime-tunnel", () => ({ isRelayModeActive: () => false }))
mock.module("@/lib/platform", () => ({ isCapacitorApp: () => capacitor }))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const event = (sequence: number) => ({
  protocolVersion: 1,
  kind: "event" as const,
  name: "session.snapshot" as const,
  sequence,
  sessionId: "session-1",
  directory: "/workspace",
  payload: { snapshot: { sessionId: "session-1", directory: "/workspace", isStreaming: false, lifecycle: "idle" as const, queue: { steering: 0, followUp: 0 }, lastSequence: sequence } },
})

describe("createPiEventStream", () => {
  beforeEach(() => {
    runtimeKey = "runtime-a"
    capacitor = false
    streamUrls.length = 0
    runtimeFetch.mockReset()
    refreshRuntimeUrlAuthToken.mockReset()
    openRuntimeWebSocket.mockReset()
  })


  test("uses SSE directly in auto mode and preserves the snapshot cursor", async () => {
    const encoder = new TextEncoder()
    runtimeFetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event(8))}\n\n`))
      },
    })))
    const received: number[] = []
    const switches: string[] = []
    const handle = (await import("./transport")).createPiEventStream({
      onEvent: (frame) => received.push(frame.sequence),
      onTransportSwitch: () => switches.push("sse"),
    }, { sessionId: "session-1", fromSequence: 7, transport: "auto" })

    await flush()
    expect(switches).toEqual([])
    expect(refreshRuntimeUrlAuthToken.mock.calls).toEqual([])
    expect(streamUrls.some((entry) => entry.transport === "sse" && entry.query.sessionId === "session-1" && entry.query.fromSequence === "7")).toBe(true)
    expect(received).toEqual([8])
    expect(handle.eventsUrl).toBe("http://runtime/api/pi/events")
    handle.dispose()
  })

  test("resumes a manually reconnected WebSocket from the last accepted sequence", async () => {
    const sockets: Array<Record<string, ((event?: { data?: string; code?: number }) => void) | undefined>> = []
    refreshRuntimeUrlAuthToken.mockResolvedValue(undefined)
    openRuntimeWebSocket.mockImplementation(() => {
      const socket: Record<string, ((event?: { data?: string; code?: number }) => void) | undefined> = { close: () => undefined }
      sockets.push(socket)
      return socket
    })
    const { createPiEventStream } = await import("./transport")
    const handle = createPiEventStream({ onEvent: () => {} }, { sessionId: "session-1", fromSequence: 2, transport: "ws", reconnectDelayMs: 0 })
    await flush()
    sockets[0].onopen?.()
    sockets[0].onmessage?.({ data: JSON.stringify(event(6)) })
    handle.reconnect()
    await flush()
    await flush()
    expect(streamUrls.some((entry) => entry.transport === "ws" && entry.query.sessionId === "session-1" && entry.query.fromSequence === "6")).toBe(true)
    handle.dispose()
  })

  test("uses EventSource on direct Capacitor runtimes instead of buffered fetch", async () => {
    const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource
    const received: number[] = []
    const sources: Array<{
      url: string
      onopen?: () => void
      onmessage?: (event: { data?: string }) => void
      onerror?: () => void
      close: () => void
    }> = []
    class FakeEventSource {
      url: string
      onopen?: () => void
      onmessage?: (event: { data?: string }) => void
      onerror?: () => void
      constructor(url: string) {
        this.url = url
        sources.push(this)
      }
      close() {}
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource })
    capacitor = true
    refreshRuntimeUrlAuthToken.mockResolvedValue(undefined)

    try {
      const { createPiEventStream } = await import("./transport")
      const handle = createPiEventStream({
        onEvent: (frame) => received.push(frame.sequence),
      }, { sessionId: "session-1", fromSequence: 7 })

      await flush()
      expect(refreshRuntimeUrlAuthToken.mock.calls.length).toBe(1)
      expect(runtimeFetch.mock.calls.length).toBe(0)
      expect(sources).toHaveLength(1)
      expect(sources[0]?.url).toBe("http://runtime/api/pi/events")
      sources[0]?.onopen?.()
      sources[0]?.onmessage?.({ data: JSON.stringify(event(8)) })
      expect(received).toEqual([8])
      handle.dispose()
    } finally {
      capacitor = false
      Object.defineProperty(globalThis, "EventSource", {
        configurable: true,
        value: originalEventSource,
      })
    }
  })
})
