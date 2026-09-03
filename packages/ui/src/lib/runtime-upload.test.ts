import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runtimeUpload, type RuntimeUploadProgress } from "./runtime-upload";

const originalFetch = globalThis.fetch;

type FetchCall = { url: string | URL | Request; init?: RequestInit };
const calls: FetchCall[] = [];

const installFetchMock = (responder: (call: FetchCall) => Response | Promise<Response>) => {
  calls.length = 0;
  const fn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url, init };
    calls.push(call);
    return responder(call);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
};

describe("runtimeUpload", () => {
  beforeEach(() => {
    installFetchMock(() => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses Blob directly without duplex: half on native HTTP fetch", async () => {
    const file = new Blob(["hello world"], { type: "text/plain" });
    const progressUpdates: RuntimeUploadProgress[] = [];

    const response = await runtimeUpload("/api/pi/attachments", file, {
      filename: "test.txt",
      mime: "text/plain",
      onProgress: (p) => progressUpdates.push(p),
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe(file);
    // Must NOT have duplex: 'half' for direct fetch, avoiding ERR_ALPN_NEGOTIATION_FAILED
    expect((call.init as Record<string, unknown>)?.duplex).toBe(undefined);

    // Headers must include octet-stream and metadata
    const headers = new Headers(call.init?.headers);
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
    expect(headers.get("X-PiChamber-Filename")).toBe(encodeURIComponent("test.txt"));
    expect(headers.get("X-PiChamber-Mime")).toBe("text/plain");

    // Progress should report initial 0 and completed total
    expect(progressUpdates).toEqual([
      { loaded: 0, total: file.size },
      { loaded: file.size, total: file.size },
    ]);
  });

  test("properly encodes filenames with special characters", async () => {
    const file = new Blob(["data"], { type: "text/markdown" });
    await runtimeUpload("/api/pi/attachments", file, {
      filename: "deploy allianceauth (v1.0).md",
      mime: "text/markdown",
    });

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("X-PiChamber-Filename")).toBe(encodeURIComponent("deploy allianceauth (v1.0).md"));
  });
});
