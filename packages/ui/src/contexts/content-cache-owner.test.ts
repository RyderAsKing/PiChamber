import { describe, expect, test } from "bun:test"
import type { FilesAPI } from "@/lib/api/types"
import { FileRevisionConflictError } from "@/lib/api/files-errors"
import { createContentCachedFiles } from "./content-cache-owner"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe("content cache owner", () => {
  test("reuses only strongly validated content", async () => {
    let reads = 0
    const files = {
      readFile: async (path: string) => ({ path, content: `value-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 7, mtimeMs: 1 }),
    } as unknown as FilesAPI
    const owner = createContentCachedFiles(files)

    expect((await owner.files.readFile!("file.ts")).content).toBe("value-1")
    expect((await owner.files.readFile!("file.ts")).content).toBe("value-1")
    expect(reads).toBe(1)
    owner.dispose()
  })

  test("does not retain size-only reads without mtime", async () => {
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => ({ path, content: `value-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 7 }),
    } as unknown as FilesAPI)

    await owner.files.readFile!("file.ts")
    await owner.files.readFile!("file.ts")
    expect(reads).toBe(2)
    owner.dispose()
  })

  test("retries a read that overlaps a write", async () => {
    const firstRead = deferred<{ path: string; content: string }>()
    let content = "old"
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => {
        reads += 1
        return reads === 1 ? firstRead.promise : { path, content }
      },
      statFile: async () => ({ isFile: true, isDirectory: false, size: content.length, mtimeMs: content === "old" ? 1 : 2 }),
      writeFile: async (_path: string, next: string) => { content = next },
    } as unknown as FilesAPI)

    const reading = owner.files.readFile!("file.ts")
    await owner.files.writeFile!("file.ts", "new")
    firstRead.resolve({ path: "file.ts", content: "old" })

    expect((await reading).content).toBe("new")
    expect(reads).toBe(2)
    owner.dispose()
  })

  test("separates identical paths by directory scope", async () => {
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string, options?: Parameters<NonNullable<FilesAPI['readFile']>>[1]) => ({ path, content: `${options?.directory}-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 1, mtimeMs: 1 }),
    } as unknown as FilesAPI)

    const first = await owner.files.readFile!("file.ts", { directory: "/a" })
    const second = await owner.files.readFile!("file.ts", { directory: "/b" })
    expect(first.content).toBe("/a-1")
    expect(second.content).toBe("/b-2")
    owner.dispose()
  })

  test("disposed owners throw on subsequent reads", async () => {
    const owner = createContentCachedFiles({
      readFile: async (path: string) => ({ path, content: "value" }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 5, mtimeMs: 1 }),
    } as unknown as FilesAPI)

    owner.dispose()
    await expect(owner.files.readFile!("notes.txt", { optional: true, directory: "/tmp/project" }))
      .rejects.toThrow("File cache owner disposed")
  })

  test("forwards guarded write options to the underlying API", async () => {
    const calls: Array<{ path: string; content: string; options?: unknown }> = []
    const owner = createContentCachedFiles({
      readFile: async (path: string) => ({ path, content: "base", revision: "v1:4:1:abc" }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 4, mtimeMs: 1 }),
      writeFile: async (path: string, content: string, options?: unknown) => {
        calls.push({ path, content, options })
        return { success: true, path, revision: "v1:4:2:def" }
      },
    } as unknown as FilesAPI)

    const result = await owner.files.writeFile!("file.ts", "next", { expectedRevision: "v1:4:1:abc" })
    expect(result.success).toBe(true)
    expect(result.revision).toBe("v1:4:2:def")
    expect(calls).toHaveLength(1)
    expect(calls[0].options).toEqual({ expectedRevision: "v1:4:1:abc" })
    owner.dispose()
  })

  test("forwards overwrite option and create-only null expectedRevision", async () => {
    const calls: Array<unknown> = []
    const owner = createContentCachedFiles({
      writeFile: async (_path: string, _content: string, options?: unknown) => {
        calls.push(options)
        return { success: true, path: _path }
      },
    } as unknown as FilesAPI)

    await owner.files.writeFile!("new.ts", "", { expectedRevision: null })
    await owner.files.writeFile!("new.ts", "x", { expectedRevision: "v1:1:2:aa", overwrite: true })
    expect(calls[0]).toEqual({ expectedRevision: null })
    expect(calls[1]).toEqual({ expectedRevision: "v1:1:2:aa", overwrite: true })
    owner.dispose()
  })

  test("cached hits preserve the exact read revision", async () => {
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => ({ path, content: `value-${++reads}`, revision: `rev-${reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 7, mtimeMs: 1 }),
    } as unknown as FilesAPI)

    const first = await owner.files.readFile!("file.ts")
    const second = await owner.files.readFile!("file.ts")
    expect(reads).toBe(1)
    expect(second.content).toBe(first.content)
    expect(second.revision).toBe("rev-1")
    owner.dispose()
  })

  test("propagates typed conflicts and invalidates cached content", async () => {
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => ({ path, content: `value-${++reads}`, revision: `rev-${reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 7, mtimeMs: 1 }),
      writeFile: async () => {
        throw new FileRevisionConflictError("File has changed on disk", { currentRevision: "rev-9", exists: true })
      },
    } as unknown as FilesAPI)

    await owner.files.readFile!("file.ts")
    await expect(owner.files.writeFile!("file.ts", "next", { expectedRevision: "rev-1" }))
      .rejects.toBeInstanceOf(FileRevisionConflictError)
    expect(reads).toBe(1)
    // The write invalidates the entry even on conflict: the next read refetches.
    const after = await owner.files.readFile!("file.ts")
    expect(reads).toBe(2)
    expect(after.content).toBe("value-2")
    expect(after.revision).toBe("rev-2")
    owner.dispose()
  })

  test("guarded writes invalidate the cache and reads adopt the new revision", async () => {
    let content = "base"
    let mtime = 1
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => {
        reads += 1
        return { path, content, revision: `rev:${content}:${mtime}` }
      },
      statFile: async () => ({ isFile: true, isDirectory: false, size: content.length, mtimeMs: mtime }),
      writeFile: async (path: string, next: string) => {
        content = next
        mtime += 1
        return { success: true, path, revision: `rev:${content}:${mtime}` }
      },
    } as unknown as FilesAPI)

    const first = await owner.files.readFile!("file.ts")
    expect(first.revision).toBe("rev:base:1")
    const written = await owner.files.writeFile!("file.ts", "next", { expectedRevision: first.revision })
    expect(written.revision).toBe("rev:next:2")
    const second = await owner.files.readFile!("file.ts")
    expect(second.content).toBe("next")
    expect(second.revision).toBe("rev:next:2")
    expect(reads).toBe(2)
    owner.dispose()
  })

  test("runtime endpoint changes clear cached revisions", async () => {
    const originalWindow = globalThis.window
    const events = new EventTarget()
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
      },
    })

    try {
      let reads = 0
      const owner = createContentCachedFiles({
        readFile: async (path: string) => ({ path, content: `value-${++reads}`, revision: `rev-${reads}` }),
        statFile: async () => ({ isFile: true, isDirectory: false, size: 7, mtimeMs: 1 }),
      } as unknown as FilesAPI)

      expect((await owner.files.readFile!("notes.txt")).revision).toBe("rev-1")
      window.dispatchEvent(new CustomEvent("pichamber:runtime-endpoint-will-change", {
        detail: {
          apiBaseUrl: "http://127.0.0.1:3902",
          previousApiBaseUrl: "http://127.0.0.1:3901",
          runtimeKey: "url:http://127.0.0.1:3902",
          previousRuntimeKey: "url:http://127.0.0.1:3901",
        },
      }))
      const after = await owner.files.readFile!("notes.txt")
      expect(after.content).toBe("value-2")
      expect(after.revision).toBe("rev-2")
      expect(reads).toBe(2)
      owner.dispose()
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      })
    }
  })
})
