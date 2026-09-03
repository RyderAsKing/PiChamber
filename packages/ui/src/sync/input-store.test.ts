import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { piClient } from "@/lib/pi/client"
import { useInputStore } from "./input-store"

const originalUploadAttachment = piClient.uploadAttachment
const originalDeleteAttachment = piClient.deleteAttachment
const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for attachment state")
}

const readyUpload = async (file: Blob, input: { filename: string; mime: string; onProgress?: (progress: { loaded: number; total: number }) => void }) => {
  input.onProgress?.({ loaded: file.size, total: file.size })
  return { id: `uploaded-${input.filename}`, name: input.filename, mime: input.mime, size: file.size, expiresAt: Date.now() + 60_000 }
}

describe("input-store attachment lifecycle", () => {
  beforeEach(() => {
    piClient.uploadAttachment = readyUpload
    piClient.deleteAttachment = async () => undefined
    useInputStore.getState().setAttachedFiles([])
  })

  afterEach(() => {
    useInputStore.getState().clearAttachedFiles()
    piClient.uploadAttachment = originalUploadAttachment
    piClient.deleteAttachment = originalDeleteAttachment
  })

  test("uploads a prepared file without retaining a base64 copy", async () => {
    expect(await useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))).toBe(true)
    await waitFor(() => useInputStore.getState().attachedFiles[0]?.uploadState?.status === "ready")

    const attachment = useInputStore.getState().attachedFiles[0]
    expect(attachment.filename).toBe("hello.txt")
    expect(attachment.mimeType).toBe("text/plain")
    expect(attachment.dataUrl).toBe("")
    expect(attachment.uploadState?.status).toBe("ready")
  })

  test("publishes progress only on the changed attachment and preserves sibling identity", async () => {
    let publishProgress: ((loaded: number) => void) | undefined
    let finish: (() => void) | undefined
    piClient.uploadAttachment = async (file, input) => {
      publishProgress = (loaded) => input.onProgress?.({ loaded, total: file.size })
      await new Promise<void>((resolve) => { finish = resolve })
      return { id: "uploaded", name: input.filename, mime: input.mime, size: file.size, expiresAt: Date.now() + 60_000 }
    }

    useInputStore.getState().addRestoredAttachment({ url: "file:///server.txt", mimeType: "text/plain", filename: "server.txt" })
    const sibling = useInputStore.getState().attachedFiles[0]
    await useInputStore.getState().addAttachedFile(new File(["0123456789"], "local.txt", { type: "text/plain" }))
    publishProgress?.(5)

    expect(useInputStore.getState().attachedFiles[0]).toBe(sibling)
    expect(useInputStore.getState().attachedFiles[1]?.uploadState).toEqual({ status: "uploading", progress: 50 })
    finish?.()
    await waitFor(() => useInputStore.getState().attachedFiles[1]?.uploadState?.status === "ready")
  })

  test("keeps a failed file visible and retries it", async () => {
    let attempts = 0
    piClient.uploadAttachment = async (file, input) => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error("unavailable"), { code: "DAEMON_UNAVAILABLE" })
      return readyUpload(file, input)
    }

    await useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    await waitFor(() => useInputStore.getState().attachedFiles[0]?.uploadState?.status === "failed")
    const id = useInputStore.getState().attachedFiles[0].id
    useInputStore.getState().retryAttachmentUpload(id)
    await waitFor(() => useInputStore.getState().attachedFiles[0]?.uploadState?.status === "ready")
    expect(attempts).toBe(2)
  })

  test("preserves successful files when another upload fails", async () => {
    piClient.uploadAttachment = async (file, input) => {
      if (input.filename === "bad.txt") throw new Error("failed")
      return readyUpload(file, input)
    }

    await Promise.all([
      useInputStore.getState().addAttachedFile(new File(["ok"], "ok.txt", { type: "text/plain" })),
      useInputStore.getState().addAttachedFile(new File(["bad"], "bad.txt", { type: "text/plain" })),
    ])
    await waitFor(() => useInputStore.getState().attachedFiles.every((file) => file.uploadState?.status === "ready" || file.uploadState?.status === "failed"))
    expect(useInputStore.getState().attachedFiles.map((file) => file.uploadState?.status).sort()).toEqual(["failed", "ready"])
  })

  test("limits concurrent uploads to three", async () => {
    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []
    piClient.uploadAttachment = async (file, input) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return { id: input.filename, name: input.filename, mime: input.mime, size: file.size, expiresAt: Date.now() + 60_000 }
    }

    await Promise.all(["a.txt", "b.txt", "c.txt", "d.txt"].map((name) =>
      useInputStore.getState().addAttachedFile(new File([name], name, { type: "text/plain" }))))
    await waitFor(() => active === 3)
    expect(maxActive).toBe(3)
    releases.shift()?.()
    await waitFor(() => releases.length === 3)
    expect(active).toBe(3)
    while (releases.length > 0) releases.shift()?.()
    await waitFor(() => active === 0)
  })

  test("removal aborts an active upload and rejects its stale completion", async () => {
    let aborted = false
    piClient.uploadAttachment = async (_file, input) => await new Promise((_, reject) => {
      input.signal?.addEventListener("abort", () => {
        aborted = true
        reject(new DOMException("aborted", "AbortError"))
      }, { once: true })
    })

    await useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    const id = useInputStore.getState().attachedFiles[0].id
    useInputStore.getState().removeAttachedFile(id)
    await waitFor(() => aborted)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("clearing attachments prevents a delayed preparation from publishing", async () => {
    const pending = useInputStore.getState().addAttachedFile(new File(["custom text"], "example.custom", { type: "application/octet-stream" }))
    expect(useInputStore.getState().attachedFiles).toHaveLength(1)
    useInputStore.getState().clearAttachedFiles()
    await pending
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("document members publish as one group and cascade removal", async () => {
    const archive = zipSync({
      "word/document.xml": strToU8(`<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:t>Diagram</w:t><a:blip r:embed="rId1"/></w:p></w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="media/image.png" Type="image"/></Relationships>`),
      "word/media/image.png": pngBytes,
    })
    await useInputStore.getState().addAttachedFile(new File([archive], "design.docx"))
    await waitFor(() => useInputStore.getState().attachedFiles.length === 2)

    const files = useInputStore.getState().attachedFiles
    expect(files.map((file) => file.filename)).toEqual(["design.docx", "design-image-1.png"])
    expect(files[0].sourceDocumentId).toBe(files[1].sourceDocumentId)
    useInputStore.getState().removeAttachedFile(files[1].id)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("prepares and uploads a zip file on first attempt without failing", async () => {
    const zipBytes = zipSync({ "test.txt": strToU8("hello in zip") })
    const zipFile = new File([zipBytes], "archive.zip", { type: "application/zip" })
    expect(await useInputStore.getState().addAttachedFile(zipFile)).toBe(true)
    await waitFor(() => useInputStore.getState().attachedFiles[0]?.uploadState?.status === "ready")

    const attachment = useInputStore.getState().attachedFiles[0]
    expect(attachment.filename).toBe("archive.zip")
    expect(attachment.mimeType).toBe("application/zip")
    expect(attachment.uploadState?.status).toBe("ready")
  })
})

describe("input-store per-draft attachment slots", () => {
  const seedServerFile = (filename: string) => {
    useInputStore.getState().addRestoredAttachment({ url: `file:///${filename}`, mimeType: "text/plain", filename })
    const files = useInputStore.getState().attachedFiles
    return files[files.length - 1].id
  }

  beforeEach(() => {
    useInputStore.setState({
      attachedFiles: [],
      stashedAttachmentsByDraft: {},
      activeAttachmentsDraftKey: null,
    })
  })

  afterEach(() => {
    useInputStore.setState({
      attachedFiles: [],
      stashedAttachmentsByDraft: {},
      activeAttachmentsDraftKey: null,
    })
  })

  test("keeps attachment drafts scoped across a composer remount", () => {
    useInputStore.getState().activateAttachmentsDraft("draft-a")
    seedServerFile("a.txt")

    // A remounted composer only announces B. The store must still remember
    // that the visible files belong to A.
    useInputStore.getState().activateAttachmentsDraft("draft-b")
    expect(useInputStore.getState().attachedFiles).toEqual([])
    seedServerFile("b.txt")

    useInputStore.getState().activateAttachmentsDraft("draft-a")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["a.txt"])
    useInputStore.getState().activateAttachmentsDraft("draft-b")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["b.txt"])
  })

  test("activating the current draft key is a no-op", () => {
    seedServerFile("a.txt")
    useInputStore.getState().activateAttachmentsDraft("draft-a")
    useInputStore.getState().activateAttachmentsDraft("draft-a")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["a.txt"])
    expect(useInputStore.getState().stashedAttachmentsByDraft).toEqual({})
  })

  test("detaching clears sent ids from the visible list and every stash", () => {
    const currentId = seedServerFile("current.txt")
    useInputStore.getState().activateAttachmentsDraft("draft-a")
    useInputStore.getState().activateAttachmentsDraft("draft-b")
    const stashedId = seedServerFile("stashed.txt")
    useInputStore.getState().activateAttachmentsDraft("draft-a")
    // A send that resolves after a draft switch still clears its own files.
    useInputStore.getState().detachAttachedFiles([stashedId, currentId, "missing-id"])
    expect(useInputStore.getState().attachedFiles).toEqual([])
    expect(useInputStore.getState().stashedAttachmentsByDraft).toEqual({})
  })

  test("session cleanup drops only that session's stash", () => {
    useInputStore.getState().activateAttachmentsDraft(JSON.stringify(["rk", "/dir", "s1"]))
    seedServerFile("a.txt")
    useInputStore.getState().activateAttachmentsDraft("other")
    seedServerFile("b.txt")
    useInputStore.getState().activateAttachmentsDraft(JSON.stringify(["rk", "/dir", "s2"]))
    useInputStore.getState().clearStashedAttachmentsForSession({ runtimeKey: "rk", directory: "/dir", sessionId: "s1" })
    const stashed = useInputStore.getState().stashedAttachmentsByDraft
    expect(Object.keys(stashed)).toEqual(["other"])
  })

  test("empty draft switches do not evict a real attachment stash", () => {
    useInputStore.getState().activateAttachmentsDraft("draft-with-file")
    seedServerFile("keep.txt")
    useInputStore.getState().activateAttachmentsDraft("empty-0")
    for (let index = 0; index < 15; index += 1) {
      useInputStore.getState().activateAttachmentsDraft(`empty-${index + 1}`)
    }
    useInputStore.getState().activateAttachmentsDraft("draft-with-file")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["keep.txt"])
    expect(Object.keys(useInputStore.getState().stashedAttachmentsByDraft)).toHaveLength(0)
  })
})
