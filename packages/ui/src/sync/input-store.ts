/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Attachment preparation and upload live here so every composer ingress follows
 * the same lifecycle and runtime-generation checks.
 */

import { create } from "zustand"
import { piClient } from "@/lib/pi/client"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import type { AttachedFile, AttachmentUploadState } from "@/stores/types/sessionTypes"
import { prepareAttachmentFiles } from "./attachment-files"

const MAX_ATTACHMENT_PREPARATION_ATTEMPTS = 3
const MAX_CONCURRENT_UPLOADS = 3
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_ATTACHMENTS_PER_MESSAGE = 20
let attachmentReadGeneration = 0
let activeUploads = 0
const uploadQueue: string[] = []
const uploadControllers = new Map<string, AbortController>()
const uploadGenerations = new Map<string, number>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

const hasGeneratedFilenameCollision = (filenames: string[], attachedFiles: AttachedFile[]): boolean => {
  if (filenames.length === 0) return false
  const attachedFilenames = new Set(attachedFiles.map((attachment) => attachment.filename.toLowerCase()))
  return filenames.some((filename) => attachedFilenames.has(filename.toLowerCase()))
}

const createId = (prefix = "attachment") => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`

const createPreviewUrl = (file: File, mime: string): string | undefined => {
  if (!mime.startsWith("image/") || typeof URL.createObjectURL !== "function") return undefined
  return URL.createObjectURL(file)
}

const readFileAsDataUrl = (file: Blob, mime: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => {
    const value = typeof reader.result === "string" ? reader.result : ""
    const commaIndex = value.indexOf(",")
    resolve(commaIndex === -1 ? value : `data:${mime};base64,${value.slice(commaIndex + 1)}`)
  }
  reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
  reader.onabort = () => reject(new Error("File read aborted"))
  reader.readAsDataURL(file)
})

export const serializeAttachmentsForQueue = async (files: readonly AttachedFile[]): Promise<AttachedFile[]> =>
  Promise.all(files.map(async (file) => {
    if (file.source !== "local" || file.dataUrl.startsWith("data:")) return file
    const blob = file.file instanceof Blob ? file.file : null
    if (!blob) throw new Error("Attachment data is unavailable")
    return { ...file, dataUrl: await readFileAsDataUrl(blob, file.mimeType), previewUrl: undefined }
  }))

const getDataUrlByteSize = (url: string): number => {
  if (!url.startsWith("data:")) return 0
  const commaIndex = url.indexOf(",")
  if (commaIndex < 0) return 0
  const metadata = url.slice(0, commaIndex).toLowerCase()
  const payload = url.slice(commaIndex + 1)
  if (!metadata.endsWith(";base64")) return 0
  let padding = 0
  if (payload.endsWith("==")) padding = 2
  else if (payload.endsWith("=")) padding = 1
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

const dataUrlToBlob = (dataUrl: string, fallbackMime: string): Blob | null => {
  const comma = dataUrl.indexOf(",")
  if (!dataUrl.startsWith("data:") || comma < 0) return null
  const metadata = dataUrl.slice(5, comma)
  if (!metadata.toLowerCase().endsWith(";base64")) return null
  try {
    const binary = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: metadata.slice(0, -7) || fallbackMime })
  } catch {
    return null
  }
}

const safeUploadError = (error: unknown): string => {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : ""
  if (code === "ATTACHMENT_TOO_LARGE") return "File exceeds the 100 MB upload limit."
  if (code === "ATTACHMENT_LIMIT_REACHED") return "Too many unused uploads. Remove a file and retry."
  if (code === "DAEMON_UNAVAILABLE") return "The runtime changed or is unavailable. Retry the upload."
  if (error instanceof DOMException && error.name === "AbortError") return "Upload canceled."
  return "Upload failed. Retry or remove this file."
}

const updateAttachment = (id: string, update: (file: AttachedFile) => AttachedFile): boolean => {
  let found = false
  useInputStore.setState((state) => ({
    attachedFiles: state.attachedFiles.map((file) => {
      if (file.id !== id) return file
      found = true
      return update(file)
    }),
  }))
  return found
}

const startQueuedUploads = (): void => {
  while (activeUploads < MAX_CONCURRENT_UPLOADS && uploadQueue.length > 0) {
    const id = uploadQueue.shift()
    if (!id) continue
    const file = useInputStore.getState().attachedFiles.find((candidate) => candidate.id === id)
    if (!file || file.source !== "local" || file.uploadState?.status !== "preparing") continue
    activeUploads += 1
    void uploadAttachment(id).finally(() => {
      activeUploads -= 1
      startQueuedUploads()
    })
  }
}

const enqueueUpload = (id: string): void => {
  if (uploadQueue.includes(id) || uploadControllers.has(id)) return
  uploadQueue.push(id)
  startQueuedUploads()
}

const uploadAttachment = async (id: string): Promise<void> => {
  const initial = useInputStore.getState().attachedFiles.find((file) => file.id === id)
  if (!initial || initial.source !== "local") return
  const blob = initial.file instanceof Blob ? initial.file : dataUrlToBlob(initial.dataUrl, initial.mimeType)
  if (!blob || blob.size === 0) {
    updateAttachment(id, (file) => ({ ...file, uploadState: { status: "failed", error: "The file data is no longer available." } }))
    return
  }

  const runtimeKey = getRuntimeKey()
  const generation = (uploadGenerations.get(id) ?? 0) + 1
  uploadGenerations.set(id, generation)
  const controller = new AbortController()
  uploadControllers.set(id, controller)
  let lastProgress = -1
  updateAttachment(id, (file) => ({ ...file, uploadState: { status: "uploading", progress: blob.size > 0 ? 0 : null } }))

  try {
    const attachment = await piClient.uploadAttachment(blob, {
      filename: initial.filename,
      mime: initial.mimeType,
      signal: controller.signal,
      onProgress: ({ loaded, total }) => {
        const progress = total > 0 ? Math.min(99, Math.floor((loaded / total) * 100)) : null
        if (progress === lastProgress) return
        lastProgress = progress ?? lastProgress
        if (uploadGenerations.get(id) !== generation || runtimeKey !== getRuntimeKey()) return
        updateAttachment(id, (file) => file.uploadState?.status === "uploading"
          ? { ...file, uploadState: { status: "uploading", progress } }
          : file)
      },
    }, { runtimeKey })
    if (uploadGenerations.get(id) !== generation || runtimeKey !== getRuntimeKey()) {
      void piClient.deleteAttachment(attachment.id, { runtimeKey }).catch(() => undefined)
      return
    }
    updateAttachment(id, (file) => ({
      ...file,
      uploadState: { status: "ready", attachmentId: attachment.id, expiresAt: attachment.expiresAt },
    }))
    const expiryTimer = setTimeout(() => {
      expiryTimers.delete(id)
      updateAttachment(id, (file) => file.uploadState?.status === "ready" && file.uploadState.attachmentId === attachment.id
        ? { ...file, uploadState: { status: "failed", error: "Upload expired. Retry the upload." } }
        : file)
    }, Math.max(0, attachment.expiresAt - Date.now() + 1))
    expiryTimers.set(id, expiryTimer)
  } catch (error) {
    if (uploadGenerations.get(id) !== generation) return
    updateAttachment(id, (file) => ({ ...file, uploadState: { status: "failed", error: safeUploadError(error) } }))
  } finally {
    if (uploadControllers.get(id) === controller) uploadControllers.delete(id)
  }
}

const cancelAttachment = (file: AttachedFile, deleteRemote: boolean): void => {
  uploadGenerations.set(file.id, (uploadGenerations.get(file.id) ?? 0) + 1)
  uploadControllers.get(file.id)?.abort()
  uploadControllers.delete(file.id)
  const expiryTimer = expiryTimers.get(file.id)
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimers.delete(file.id)
  const queuedIndex = uploadQueue.indexOf(file.id)
  if (queuedIndex >= 0) uploadQueue.splice(queuedIndex, 1)
  if (file.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(file.previewUrl)
  if (deleteRemote && file.uploadState?.status === "ready") {
    void piClient.deleteAttachment(file.uploadState.attachmentId, { runtimeKey: getRuntimeKey() }).catch(() => undefined)
  }
}

const cancelFiles = (files: readonly AttachedFile[], deleteRemote: boolean): void => {
  for (const file of files) cancelAttachment(file, deleteRemote)
}

/** Stash bound: entries hold File handles and data URLs, unlike text drafts. */
const MAX_STASHED_ATTACHMENT_DRAFTS = 10

export type SyntheticContextPart = {
  text: string
  attachments?: AttachedFile[]
  synthetic?: boolean
}

export type InputState = {
  pendingInputText: string | null
  pendingInputMode: "replace" | "append" | "append-inline"
  pendingRevertText: string | null
  pendingSyntheticParts: SyntheticContextPart[] | null
  /** Pinned prompt starter insertion (never an immediate send). */
  pendingStarterInsert: { name: string } | null
  attachedFiles: AttachedFile[]
  /**
   * Attachments stashed per chat-draft key (runtime, directory, session).
   * Switching sessions swaps the visible `attachedFiles` like the text
   * draft swap; stashes are memory-only (File handles cannot persist).
   */
  stashedAttachmentsByDraft: Record<string, AttachedFile[]>
  /** Draft identity that currently owns `attachedFiles`; survives composer remounts. */
  activeAttachmentsDraftKey: string | null

  setPendingInputText: (text: string | null, mode?: "replace" | "append" | "append-inline") => void
  consumePendingInputText: () => { text: string; mode: "replace" | "append" | "append-inline" } | null
  setPendingRevertText: (text: string | null) => void
  consumePendingRevertText: () => string | null
  requestStarterInsert: (name: string) => void
  consumePendingStarterInsert: () => { name: string } | null
  setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => void
  consumePendingSyntheticParts: () => SyntheticContextPart[] | null
  addAttachedFile: (file: File) => Promise<boolean>
  retryAttachmentUpload: (id: string) => void
  removeAttachedFile: (id: string) => void
  detachAttachedFiles: (ids: readonly string[]) => void
  clearStashedAttachmentsForSession: (identity: { runtimeKey: string; directory: string; sessionId: string }) => void
  /**
   * Make a draft's attachments visible, stashing the previous draft's files.
   * Store-owned identity survives composer remounts and loading transitions.
   */
  activateAttachmentsDraft: (nextKey: string) => void
  setAttachedFiles: (files: AttachedFile[]) => void
  clearAttachedFiles: () => void
  addRestoredAttachment: (file: { url: string; mimeType: string; filename: string }) => void
}

export const useInputStore = create<InputState>()((set, get) => ({
  pendingInputText: null,
  pendingInputMode: "replace",
  pendingRevertText: null,
  pendingSyntheticParts: null,
  pendingStarterInsert: null,
  attachedFiles: [],
  stashedAttachmentsByDraft: {},
  activeAttachmentsDraftKey: null,

  setPendingInputText: (text, mode = "replace") => set({ pendingInputText: text, pendingInputMode: mode }),
  consumePendingInputText: () => {
    const { pendingInputText, pendingInputMode } = get()
    if (pendingInputText === null) return null
    set({ pendingInputText: null, pendingInputMode: "replace" })
    return { text: pendingInputText, mode: pendingInputMode }
  },
  setPendingRevertText: (text) => set({ pendingRevertText: text }),
  consumePendingRevertText: () => {
    const { pendingRevertText } = get()
    if (pendingRevertText === null) return null
    set({ pendingRevertText: null })
    return pendingRevertText
  },
  requestStarterInsert: (name) => set({ pendingStarterInsert: { name } }),
  consumePendingStarterInsert: () => {
    const { pendingStarterInsert } = get()
    if (pendingStarterInsert === null) return null
    set({ pendingStarterInsert: null })
    return pendingStarterInsert
  },
  setPendingSyntheticParts: (parts) => set({ pendingSyntheticParts: parts }),
  consumePendingSyntheticParts: () => {
    const { pendingSyntheticParts } = get()
    if (pendingSyntheticParts !== null) set({ pendingSyntheticParts: null })
    return pendingSyntheticParts
  },

  addAttachedFile: async (file: File) => {
    const generation = attachmentReadGeneration
    const placeholderId = createId("preparing")
    const placeholder: AttachedFile = {
      id: placeholderId,
      file,
      dataUrl: "",
      mimeType: file.type || "application/octet-stream",
      filename: file.name,
      size: file.size,
      source: "local",
      uploadState: { status: "preparing" },
    }
    set((state) => ({ attachedFiles: [...state.attachedFiles, placeholder] }))
    if (get().attachedFiles.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.` } }))
      return false
    }

    for (let attempt = 0; attempt < MAX_ATTACHMENT_PREPARATION_ATTEMPTS; attempt += 1) {
      const reservedFilenames = get().attachedFiles.filter((attachment) => attachment.id !== placeholderId).map((attachment) => attachment.filename)
      let preparedFiles
      try {
        const preparedOrPending = prepareAttachmentFiles(file, reservedFilenames)
        preparedFiles = preparedOrPending instanceof Promise ? await preparedOrPending : preparedOrPending
      } catch {
        preparedFiles = null
      }
      if (generation !== attachmentReadGeneration || !get().attachedFiles.some((item) => item.id === placeholderId)) return false
      if (!preparedFiles || preparedFiles.length === 0) {
        updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: "This file could not be prepared." } }))
        return false
      }
      if (get().attachedFiles.length - 1 + preparedFiles.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.` } }))
        return false
      }
      if (preparedFiles.some((prepared) => prepared.file.size > MAX_ATTACHMENT_BYTES)) {
        updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: "File exceeds the 100 MB upload limit." } }))
        return false
      }

      const generatedFilenames = preparedFiles.slice(1).map((prepared) => prepared.file.name)
      if (hasGeneratedFilenameCollision(generatedFilenames, get().attachedFiles.filter((item) => item.id !== placeholderId))) continue

      const sourceDocumentId = preparedFiles.length > 1 ? createId("document") : undefined
      const attachedFiles: AttachedFile[] = preparedFiles.map((prepared) => ({
        id: createId(),
        file: prepared.file,
        dataUrl: "",
        previewUrl: createPreviewUrl(prepared.file, prepared.mimeType),
        mimeType: prepared.mimeType,
        filename: prepared.file.name,
        size: prepared.file.size,
        source: "local" as const,
        uploadState: { status: "preparing" } as const,
        sourceDocumentId,
      }))

      if (generation !== attachmentReadGeneration) {
        cancelFiles(attachedFiles, false)
        return false
      }
      if (hasGeneratedFilenameCollision(generatedFilenames, get().attachedFiles.filter((item) => item.id !== placeholderId))) {
        cancelFiles(attachedFiles, false)
        continue
      }
      set((state) => ({
        attachedFiles: state.attachedFiles.flatMap((item) => item.id === placeholderId ? attachedFiles : [item]),
      }))
      for (const attached of attachedFiles) enqueueUpload(attached.id)
      return true
    }

    updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: "Generated filenames conflict with existing attachments." } }))
    return false
  },

  retryAttachmentUpload: (id) => {
    const file = get().attachedFiles.find((item) => item.id === id)
    if (!file || file.source !== "local") return
    if (file.sourceDocumentId) {
      for (const member of get().attachedFiles.filter((item) => item.sourceDocumentId === file.sourceDocumentId)) {
        if (member.uploadState?.status === "failed" || (member.uploadState?.status === "ready" && member.uploadState.expiresAt <= Date.now())) {
          updateAttachment(member.id, (item) => ({ ...item, uploadState: { status: "preparing" } }))
          enqueueUpload(member.id)
        }
      }
      return
    }
    updateAttachment(id, (item) => ({ ...item, uploadState: { status: "preparing" } }))
    enqueueUpload(id)
  },

  removeAttachedFile: (id) => {
    const target = get().attachedFiles.find((file) => file.id === id)
    if (!target) return
    const removed = target.sourceDocumentId
      ? get().attachedFiles.filter((file) => file.sourceDocumentId === target.sourceDocumentId)
      : [target]
    cancelFiles(removed, true)
    const removedIds = new Set(removed.map((file) => file.id))
    set((state) => ({ attachedFiles: state.attachedFiles.filter((file) => !removedIds.has(file.id)) }))
  },

  detachAttachedFiles: (ids) => {
    const idSet = new Set(ids)
    // Ids are globally unique, so a send that resolves after a draft switch
    // still clears its own files: sweep the visible list and every stash.
    // Stashed uploads are left running; only the visible detach cancels.
    const removed = get().attachedFiles.filter((file) => idSet.has(file.id))
    cancelFiles(removed, false)
    const stashed = get().stashedAttachmentsByDraft
    let nextStashed = stashed
    if (stashed) {
      nextStashed = {}
      for (const [key, files] of Object.entries(stashed)) {
        const kept = files.filter((file) => !idSet.has(file.id))
        if (kept.length > 0) nextStashed[key] = kept
      }
    }
    set((state) => ({
      attachedFiles: state.attachedFiles.filter((file) => !idSet.has(file.id)),
      stashedAttachmentsByDraft: nextStashed,
    }))
  },

  activateAttachmentsDraft: (nextKey) => {
    const prevKey = get().activeAttachmentsDraftKey
    if (prevKey === null) {
      set({ activeAttachmentsDraftKey: nextKey })
      return
    }
    if (prevKey === nextKey) return
    const stashed = get().stashedAttachmentsByDraft
    const current = get().attachedFiles
    const restored = stashed[nextKey] ?? []
    // Refresh recency, then bound the stash: entries hold File handles and
    // data URLs, so unlike text drafts this stays small.
    const nextStashed: Record<string, AttachedFile[]> = {}
    for (const [key, files] of Object.entries(stashed)) {
      if (key !== prevKey && key !== nextKey) nextStashed[key] = files
    }
    if (current.length > 0) nextStashed[prevKey] = current
    const keys = Object.keys(nextStashed)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STASHED_ATTACHMENT_DRAFTS))) {
      cancelFiles(nextStashed[key] ?? [], true)
      delete nextStashed[key]
    }
    set({
      attachedFiles: restored,
      stashedAttachmentsByDraft: nextStashed,
      activeAttachmentsDraftKey: nextKey,
    })
  },

  clearStashedAttachmentsForSession: (identity) => {
    const matchesIdentity = (key: string): boolean => {
      try {
        const parsed = JSON.parse(key) as Partial<[string, string, string | null]>
        return Array.isArray(parsed)
          && parsed[0] === identity.runtimeKey
          && parsed[1] === identity.directory
          && parsed[2] === identity.sessionId
      } catch {
        return false
      }
    }
    const state = get()
    const nextStashed: Record<string, AttachedFile[]> = {}
    for (const [key, files] of Object.entries(state.stashedAttachmentsByDraft)) {
      if (matchesIdentity(key)) cancelFiles(files, true)
      else nextStashed[key] = files
    }
    const clearsVisible = state.activeAttachmentsDraftKey !== null
      && matchesIdentity(state.activeAttachmentsDraftKey)
    if (clearsVisible) cancelFiles(state.attachedFiles, true)
    set({
      attachedFiles: clearsVisible ? [] : state.attachedFiles,
      stashedAttachmentsByDraft: nextStashed,
    })
  },

  setAttachedFiles: (files) => {
    attachmentReadGeneration += 1
    cancelFiles(get().attachedFiles, false)
    set({
      attachedFiles: files.map((file): AttachedFile => file.source === "local" && file.uploadState === undefined
        ? { ...file, uploadState: { status: "failed", error: "Upload needs to be refreshed. Retry the upload." } }
        : file),
    })
  },

  clearAttachedFiles: () => {
    attachmentReadGeneration += 1
    cancelFiles(get().attachedFiles, true)
    set({ attachedFiles: [] })
  },

  addRestoredAttachment: ({ url, mimeType, filename }) => {
    const id = createId("restored")
    const file = new File([], filename, { type: mimeType })
    const attached: AttachedFile = {
      id,
      file,
      dataUrl: url,
      mimeType,
      filename,
      size: getDataUrlByteSize(url),
      source: "server",
      serverPath: url,
    }
    set((state) => ({ attachedFiles: [...state.attachedFiles, attached] }))
  },
}))

subscribeRuntimeEndpointWillChange(() => {
  attachmentReadGeneration += 1
  const markRuntimeChanged = (files: AttachedFile[]): AttachedFile[] => files.map((file): AttachedFile => file.source === "local"
    ? { ...file, uploadState: { status: "failed", error: "The runtime changed. Retry the upload." } satisfies AttachmentUploadState }
    : file)
  const files = useInputStore.getState().attachedFiles
  cancelFiles(files, false)
  const stashed = useInputStore.getState().stashedAttachmentsByDraft ?? {}
  const nextStashed: Record<string, AttachedFile[]> = {}
  for (const [key, stashedFiles] of Object.entries(stashed)) {
    cancelFiles(stashedFiles, false)
    nextStashed[key] = markRuntimeChanged(stashedFiles)
  }
  useInputStore.setState({
    attachedFiles: markRuntimeChanged(files),
    stashedAttachmentsByDraft: nextStashed,
  })
})
