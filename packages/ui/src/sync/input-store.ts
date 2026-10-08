/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Attachment preparation and upload live here so every composer ingress follows
 * the same lifecycle and runtime-generation checks.
 */

import { create } from "zustand"
import { piClient } from "@/lib/pi/client"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import type { AttachedFile, AttachmentUploadState } from "@/stores/types/sessionTypes"
import type { WorktreeFailedSend } from "@/stores/useWorktreeCreationStore"
import { cloneAttachmentSnapshot } from "./attachment-snapshots"
import { prepareAttachmentFiles } from "./attachment-files"
import i18n from "@/i18n"

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

/**
 * Preview URL ownership: the composer draft owns every object URL from
 * `createPreviewUrl` while it is visible (`attachedFiles`) or stashed
 * (`stashedAttachmentsByDraft`). Session-switch transfers ownership between
 * the two without revoking; restore reuses the same URL.
 *
 * Handoffs that leave the draft (queue entries, worktree captures,
 * failed-send records, retry clones) receive clones with `previewUrl`
 * stripped and never own a URL: dispatch uses `dataUrl`/upload ids and no
 * message/transcript UI renders `previewUrl` (`sendMessage` maps
 * `url: dataUrl`; queue chips show counts only). `serializeAttachmentsForQueue`
 * and `cloneAttachmentSnapshot` never release: the source stays in the draft
 * until the caller detaches it after a successful handoff, so a failed queue
 * or send keeps a working preview. The last
 * store-owned copy's drop (remove/detach/clear/replace/evict/session
 * cleanup) revokes exactly once via the guard below. Retained files (failed
 * or expired uploads awaiting retry, runtime-switch retryables) keep their
 * URLs because they are still rendered.
 */
const revokedPreviewUrls = new Set<string>()

const revokePreviewUrl = (url: string | undefined): void => {
  if (!url || revokedPreviewUrls.has(url)) return
  revokedPreviewUrls.add(url)
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url)
}

const revokePreviewUrls = (files: readonly AttachedFile[]): void => {
  for (const file of files) revokePreviewUrl(file.previewUrl)
}

const readFileAsDataUrl = (file: Blob, mime: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => {
    const value = typeof reader.result === "string" ? reader.result : ""
    const commaIndex = value.indexOf(",")
    resolve(commaIndex === -1 ? value : `data:${mime};base64,${value.slice(commaIndex + 1)}`)
  }
  reader.onerror = () => reject(reader.error ?? new Error(i18n.t("Failed to read file")))
  reader.onabort = () => reject(new Error(i18n.t("File read aborted")))
  reader.readAsDataURL(file)
})

export const serializeAttachmentsForQueue = async (files: readonly AttachedFile[]): Promise<AttachedFile[]> =>
  Promise.all(files.map(async (file) => {
    // Queue entries never own a revocable URL: strip it on every path. The
    // source keeps its URL until the caller detaches it after the handoff
    // succeeds; detach performs the revoke.
    if (file.source !== "local" || file.dataUrl.startsWith("data:")) {
      return { ...file, previewUrl: undefined }
    }
    const blob = file.file instanceof Blob ? file.file : null
    if (!blob) throw new Error(i18n.t("Attachment data is unavailable"))
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
  if (code === "ATTACHMENT_TOO_LARGE") return i18n.t("File exceeds the 100 MB upload limit.")
  if (code === "ATTACHMENT_LIMIT_REACHED") return i18n.t("Too many unused uploads. Remove a file and retry.")
  if (code === "DAEMON_UNAVAILABLE") return i18n.t("The runtime changed or is unavailable. Retry the upload.")
  if (error instanceof DOMException && error.name === "AbortError") return i18n.t("Upload canceled.")
  return i18n.t("Upload failed. Retry or remove this file.")
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
    updateAttachment(id, (file) => ({ ...file, uploadState: { status: "failed", error: i18n.t("The file data is no longer available.") } }))
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
        ? { ...file, uploadState: { status: "failed", error: i18n.t("Upload expired. Retry the upload.") } }
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

const abortAttachmentTransport = (file: AttachedFile): void => {
  uploadGenerations.set(file.id, (uploadGenerations.get(file.id) ?? 0) + 1)
  uploadControllers.get(file.id)?.abort()
  uploadControllers.delete(file.id)
  const expiryTimer = expiryTimers.get(file.id)
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimers.delete(file.id)
  const queuedIndex = uploadQueue.indexOf(file.id)
  if (queuedIndex >= 0) uploadQueue.splice(queuedIndex, 1)
}

const cancelAttachment = (file: AttachedFile, deleteRemote: boolean): void => {
  abortAttachmentTransport(file)
  revokePreviewUrl(file.previewUrl)
  if (deleteRemote && file.uploadState?.status === "ready") {
    void piClient.deleteAttachment(file.uploadState.attachmentId, { runtimeKey: getRuntimeKey() }).catch(() => undefined)
  }
}

const cancelFiles = (files: readonly AttachedFile[], deleteRemote: boolean): void => {
  for (const file of files) cancelAttachment(file, deleteRemote)
}

/** Stash bound: entries hold File handles and data URLs, unlike text drafts. */
const MAX_STASHED_ATTACHMENT_DRAFTS = 10
/** Byte bound for stashed drafts: sum of `File.size` across stashed entries. */
const MAX_STASHED_ATTACHMENT_BYTES = 50 * 1024 * 1024

const stashedAttachmentBytes = (stashed: Record<string, AttachedFile[]>): number => {
  let total = 0
  for (const files of Object.values(stashed)) {
    for (const file of files) total += Number.isFinite(file.size) ? file.size : 0
  }
  return total
}

export type SyntheticContextPart = {
  text: string
  attachments?: AttachedFile[]
  synthetic?: boolean
}

export type RestoreAttachmentsForRetryResult =
  | { ok: true; restoredCount: number; totalCount: number }
  | {
      ok: false;
      reason: 'attachment-limit';
      limit: number;
      currentCount: number;
      missingCount: number;
    };

export type PendingWorktreeRestore = {
  entryKey: string;
  prompt: string;
  confirmedMentions: string[];
  targetKey: string;
  attachments: AttachedFile[];
  /** Ownership token: the exact failed payload read at restore time. */
  expectedFailedSend: WorktreeFailedSend;
};

/**
 * One-shot successful-send clear signal for a chat draft.
 *
 * A sending composer can unmount mid-send (for example, `prompt()` flips the
 * session busy synchronously and the transcript branch swaps to a fresh
 * `ChatInput` instance). The dead instance still persists the cleared draft
 * and detaches its attachments at the store level, but its `setMessage("")`
 * is a no-op, so the live instance keeps the sent text. Publishing this
 * memory-only signal lets whichever instance currently owns the same draft
 * key finish the clear. It never persists to storage and never survives a
 * runtime switch.
 */
export type SentDraftClearSignal = {
  /** Chat-draft identity key (`getChatDraftIdentityKey`) that was sent. */
  draftKey: string;
  /** Exact text that was sent; consumers clear only on strict equality. */
  text: string;
  /** Monotonic id so repeated identical sends are distinct signals. */
  nonce: number;
};

let sentDraftClearNonce = 0;

/**
 * Send/clear contract predicate shared by the publisher and every consumer:
 * a signal applies only to its own draft key and only while the composer
 * still shows exactly what was sent. Never wipe edited or retyped text.
 */
export const shouldApplySentDraftClear = (
  signal: SentDraftClearSignal | null,
  draftKey: string,
  currentText: string,
): boolean => {
  if (!signal || signal.draftKey !== draftKey) return false;
  return currentText === signal.text;
};

export type InputState = {
  pendingInputText: string | null
  pendingInputMode: "replace" | "append" | "append-inline"
  pendingRevertText: string | null
  pendingSyntheticParts: SyntheticContextPart[] | null
  /** Failed worktree send awaiting explicit restore into its target draft. Memory-only. */
  pendingWorktreeRestore: PendingWorktreeRestore | null
  /** Draft starter insertion (prompt `/name` or built-in literal text; never an immediate send). */
  pendingStarterInsert: { name: string } | { text: string } | null
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
  requestStarterTextInsert: (text: string) => void
  consumePendingStarterInsert: () => { name: string } | { text: string } | null
  setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => void
  consumePendingSyntheticParts: () => SyntheticContextPart[] | null
  requestWorktreeRestore: (restore: PendingWorktreeRestore) => void
  consumePendingWorktreeRestore: () => PendingWorktreeRestore | null
  /** Runtime-switch cleanup: drop a deferred restore so stale state cannot linger. */
  resetForRuntimeSwitch: () => void
  /**
   * One-shot successful-send clear signal (memory-only: never persisted,
   * cleared on runtime switch). Published by the sending composer after it
   * persists the cleared draft; consumed by the instance currently owning
   * the same draft key. A signal for another key must be ignored, never
   * consumed. Failure paths publish nothing.
   */
  sentDraftClear: SentDraftClearSignal | null
  publishSentDraftClear: (draftKey: string, text: string) => void
  consumeSentDraftClear: (nonce: number) => void
  addAttachedFile: (file: File) => Promise<boolean>
  retryAttachmentUpload: (id: string) => void
  removeAttachedFile: (id: string) => void
  detachAttachedFiles: (ids: readonly string[]) => void
  /**
   * Transactional missing-ID append for failed-send recovery. Appends only
   * captured ids absent from the visible draft as clones (preview URLs stay
   * stripped; dispatch previews use the retained `dataUrl`, so expired
   * uploads stay refreshable) and removes those ids from stashes to avoid
   * duplicates. Newer draft files keep order/identity. Exact limit succeeds;
   * overflow makes no visible/stash mutation and reports counts. Never
   * cancels uploads.
   */
  restoreAttachmentsForRetry: (captured: readonly AttachedFile[]) => RestoreAttachmentsForRetryResult
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
  pendingWorktreeRestore: null,
  attachedFiles: [],
  stashedAttachmentsByDraft: {},
  activeAttachmentsDraftKey: null,
  sentDraftClear: null,

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
  requestStarterTextInsert: (text) => set({ pendingStarterInsert: { text } }),
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
  requestWorktreeRestore: (restore) => set({ pendingWorktreeRestore: restore }),
  consumePendingWorktreeRestore: () => {
    const { pendingWorktreeRestore } = get()
    if (pendingWorktreeRestore === null) return null
    set({ pendingWorktreeRestore: null })
    return pendingWorktreeRestore
  },
  resetForRuntimeSwitch: () => {
    if (get().pendingWorktreeRestore !== null) set({ pendingWorktreeRestore: null })
    // A pending clear targets the previous runtime's draft identity. Drop
    // it so stale state cannot clear a same-keyed draft on the new runtime.
    if (get().sentDraftClear !== null) set({ sentDraftClear: null })
  },
  publishSentDraftClear: (draftKey, text) => {
    if (!draftKey) return
    sentDraftClearNonce += 1
    set({ sentDraftClear: { draftKey, text, nonce: sentDraftClearNonce } })
  },
  consumeSentDraftClear: (nonce) => {
    // Guarded to the exact nonce so consuming a stale signal never drops a
    // newer send's signal published before this consumer ran.
    if (get().sentDraftClear?.nonce !== nonce) return
    set({ sentDraftClear: null })
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
      updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: i18n.t("You can attach up to {{count}} files to one message.", { count: MAX_ATTACHMENTS_PER_MESSAGE }) } }))
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
        updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: i18n.t("This file could not be prepared.") } }))
        return false
      }
      if (get().attachedFiles.length - 1 + preparedFiles.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: i18n.t("You can attach up to {{count}} files to one message.", { count: MAX_ATTACHMENTS_PER_MESSAGE }) } }))
        return false
      }
      if (preparedFiles.some((prepared) => prepared.file.size > MAX_ATTACHMENT_BYTES)) {
        updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: i18n.t("File exceeds the 100 MB upload limit.") } }))
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

    updateAttachment(placeholderId, (item) => ({ ...item, uploadState: { status: "failed", error: i18n.t("Generated filenames conflict with existing attachments.") } }))
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
    // Remote ready uploads are intentionally NOT deleted: a successful
    // dispatch consumed them (the daemon owns TTL cleanup) and a refresh
    // during dispatch may have created uploads the prompt now owns. Only an
    // explicit user removal deletes an unused remote upload.
    const removed = get().attachedFiles.filter((file) => idSet.has(file.id))
    cancelFiles(removed, false)
    const stashed = get().stashedAttachmentsByDraft
    let nextStashed = stashed
    if (stashed) {
      nextStashed = {}
      for (const [key, files] of Object.entries(stashed)) {
        const kept = files.filter((file) => !idSet.has(file.id))
        // A send that resolves after a draft switch drops its stashed
        // originals here: their preview URLs die with this last owner.
        // Uploads stay running and remote bytes stay daemon-owned, matching
        // the visible-detach contract above.
        revokePreviewUrls(files.filter((file) => idSet.has(file.id)))
        if (kept.length > 0) nextStashed[key] = kept
      }
    }
    set((state) => ({
      attachedFiles: state.attachedFiles.filter((file) => !idSet.has(file.id)),
      stashedAttachmentsByDraft: nextStashed,
    }))
  },

  restoreAttachmentsForRetry: (captured) => {
    const currentCount = get().attachedFiles.length
    if (!captured || captured.length === 0) return { ok: true as const, restoredCount: 0, totalCount: currentCount }
    const visibleIds = new Set(get().attachedFiles.map((file) => file.id))
    const seenMissing = new Set<string>()
    const missing: AttachedFile[] = []
    for (const file of captured) {
      if (visibleIds.has(file.id) || seenMissing.has(file.id)) continue
      seenMissing.add(file.id)
      missing.push(file)
    }
    if (missing.length === 0) return { ok: true as const, restoredCount: 0, totalCount: currentCount }
    // All-or-none against the 20-attachment message limit: overflow reports
    // counts and leaves visible files and stashes untouched.
    if (currentCount + missing.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return {
        ok: false as const,
        reason: 'attachment-limit' as const,
        limit: MAX_ATTACHMENTS_PER_MESSAGE,
        currentCount,
        missingCount: missing.length,
      }
    }
    const missingIds = new Set(missing.map((file) => file.id))
    const stashed = get().stashedAttachmentsByDraft ?? {}
    const nextStashed: Record<string, AttachedFile[]> = {}
    for (const [key, files] of Object.entries(stashed)) {
      const kept = files.filter((file) => !missingIds.has(file.id))
      if (kept.length > 0) nextStashed[key] = kept
    }
    set((state) => ({
      attachedFiles: [
        ...state.attachedFiles,
        ...missing.map(cloneAttachmentSnapshot),
      ],
      stashedAttachmentsByDraft: nextStashed,
    }))
    return { ok: true as const, restoredCount: missing.length, totalCount: currentCount + missing.length }
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
    // Bound the stash by count and by total bytes, oldest-first. Insertion
    // order is recency (the just-stashed previous draft is newest), so
    // shifting from the front evicts the least-recently-visible draft.
    // Evicting a draft revokes its preview URLs via the guarded release.
    const evictionOrder = Object.keys(nextStashed)
    while (evictionOrder.length > MAX_STASHED_ATTACHMENT_DRAFTS || stashedAttachmentBytes(nextStashed) > MAX_STASHED_ATTACHMENT_BYTES) {
      const oldest = evictionOrder.shift()
      if (!oldest) break
      cancelFiles(nextStashed[oldest] ?? [], true)
      delete nextStashed[oldest]
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
    // Queued-edit restore (`popToInput`) re-adds the visible files it
    // already holds: revoking those URLs would orphan the retained previews,
    // so only the files that actually leave the draft are released.
    const nextIds = new Set(files.map((file) => file.id))
    cancelFiles(get().attachedFiles.filter((file) => !nextIds.has(file.id)), false)
    set({
      attachedFiles: files.map((file): AttachedFile => file.source === "local" && file.uploadState === undefined
        ? { ...file, uploadState: { status: "failed", error: i18n.t("Upload needs to be refreshed. Retry the upload.") } }
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
    ? { ...file, uploadState: { status: "failed", error: i18n.t("The runtime changed. Retry the upload.") } satisfies AttachmentUploadState }
    : file)
  const files = useInputStore.getState().attachedFiles
  // Abort transport only: the files stay visible/stashed as retryable
  // failures, so their still-rendered preview URLs must survive the switch.
  for (const file of files) abortAttachmentTransport(file)
  const stashed = useInputStore.getState().stashedAttachmentsByDraft ?? {}
  const nextStashed: Record<string, AttachedFile[]> = {}
  for (const [key, stashedFiles] of Object.entries(stashed)) {
    for (const file of stashedFiles) abortAttachmentTransport(file)
    nextStashed[key] = markRuntimeChanged(stashedFiles)
  }
  useInputStore.setState({
    attachedFiles: markRuntimeChanged(files),
    stashedAttachmentsByDraft: nextStashed,
    // A deferred same-directory restore targets the previous runtime's draft
    // identity and failed payload. Drop it so stale retained state cannot
    // linger or restore into the new runtime.
    pendingWorktreeRestore: null,
    // Same staleness rule as the deferred restore: a pending clear carries
    // the previous runtime's draft key and must not fire on the new runtime.
    sentDraftClear: null,
  })
})
