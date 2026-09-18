import "./input-store-runtime-window-setup"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { piClient } from "@/lib/pi/client"
import { getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { useInputStore } from "./input-store"

const originalUploadAttachment = piClient.uploadAttachment
const originalDeleteAttachment = piClient.deleteAttachment
const originalFetch = globalThis.fetch
const stubFetch = (async () => new Response(null, { status: 404 })) as typeof fetch

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for attachment state")
}

describe("input-store runtime endpoint change while uploading", () => {
  let previousRuntimeKey = ""

  beforeEach(() => {
    globalThis.fetch = stubFetch
    previousRuntimeKey = getRuntimeKey()
    piClient.deleteAttachment = async () => undefined
    useInputStore.setState({
      attachedFiles: [],
      stashedAttachmentsByDraft: {},
      activeAttachmentsDraftKey: null,
    })
  })

  afterEach(async () => {
    piClient.uploadAttachment = originalUploadAttachment
    piClient.deleteAttachment = originalDeleteAttachment
    switchRuntimeEndpoint({ apiBaseUrl: "http://localhost:0", runtimeKey: previousRuntimeKey })
    useInputStore.setState({
      attachedFiles: [],
      stashedAttachmentsByDraft: {},
      activeAttachmentsDraftKey: null,
    })
    // Let the best-effort URL-token mint capture the stub before restoring.
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    globalThis.fetch = originalFetch
  })

  test("marks visible and stashed uploads failed, aborts, and rejects the late stale completion", async () => {
    const deleted: string[] = []
    piClient.deleteAttachment = async (id) => {
      deleted.push(id)
    }
    let aborted = false
    let releaseStaleUpload!: () => void
    piClient.uploadAttachment = (_file, input) => new Promise((resolve) => {
      const onAbort = () => {
        aborted = true
      }
      if (input.signal?.aborted) aborted = true
      input.signal?.addEventListener("abort", onAbort, { once: true })
      releaseStaleUpload = () => {
        input.signal?.removeEventListener("abort", onAbort)
        resolve({
          id: "stale-upload-id",
          name: input.filename,
          mime: input.mime,
          size: _file.size,
          expiresAt: Date.now() + 60_000,
        })
      }
    })

    useInputStore.getState().activateAttachmentsDraft("draft-a")
    void useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    await waitFor(() => useInputStore.getState().attachedFiles.some(
      (file) => file.uploadState?.status === "uploading",
    ))

    // Stash the uploading draft, then switch runtimes: both scopes must fail.
    useInputStore.getState().activateAttachmentsDraft("draft-b")
    expect(useInputStore.getState().attachedFiles).toEqual([])
    expect(Object.keys(useInputStore.getState().stashedAttachmentsByDraft)).toContain("draft-a")

    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-b.example", runtimeKey: "runtime-b" })
    expect(aborted).toBe(true)

    useInputStore.getState().activateAttachmentsDraft("draft-a")
    const failed = useInputStore.getState().attachedFiles
    expect(failed).toHaveLength(1)
    expect(failed[0].uploadState).toEqual({
      status: "failed",
      error: "The runtime changed. Retry the upload.",
    })

    // The transport resolves late (it ignored the abort). The stale success
    // must not overwrite the failure; its remote bytes are deleted instead.
    releaseStaleUpload()
    await waitFor(() => deleted.includes("stale-upload-id"))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const settled = useInputStore.getState().attachedFiles
    expect(settled).toHaveLength(1)
    expect(settled[0].uploadState).toEqual({
      status: "failed",
      error: "The runtime changed. Retry the upload.",
    })

    // Local bytes survive the switch, so retry on the restored runtime can reach ready.
    switchRuntimeEndpoint({ apiBaseUrl: "http://localhost:0", runtimeKey: previousRuntimeKey })
    piClient.uploadAttachment = async (file, input) => ({
      id: `uploaded-${input.filename}`,
      name: input.filename,
      mime: input.mime,
      size: file.size,
      expiresAt: Date.now() + 60_000,
    })
    useInputStore.getState().retryAttachmentUpload(settled[0].id)
    await waitFor(() => useInputStore.getState().attachedFiles[0]?.uploadState?.status === "ready")
    expect(useInputStore.getState().attachedFiles[0]?.uploadState?.status).toBe("ready")
  })
})
