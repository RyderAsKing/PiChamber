/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { prepareAttachmentFiles } from "./attachment-files"

const MAX_ATTACHMENT_PREPARATION_ATTEMPTS = 3
let attachmentReadGeneration = 0

const hasGeneratedFilenameCollision = (filenames: string[], attachedFiles: AttachedFile[]): boolean => {
  if (filenames.length === 0) return false
  const attachedFilenames = new Set(attachedFiles.map((attachment) => attachment.filename.toLowerCase()))
  return filenames.some((filename) => attachedFilenames.has(filename.toLowerCase()))
}

const readFileAsDataUrl = (file: File, mime: string): Promise<string> => new Promise((resolve, reject) => {
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

const getDataUrlByteSize = (url: string): number => {
  if (!url.startsWith("data:")) return 0
  const commaIndex = url.indexOf(",")
  if (commaIndex < 0) return 0
  const metadata = url.slice(0, commaIndex).toLowerCase()
  const payload = url.slice(commaIndex + 1)
  if (!metadata.endsWith(";base64")) return 0
  let padding = 0
  if (payload.endsWith("==")) {
    padding = 2
  } else if (payload.endsWith("=")) {
    padding = 1
  }
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

export type SyntheticContextPart = {
  text: string
  attachments?: AttachedFile[]
  synthetic?: boolean
}

export type InputState = {
  pendingInputText: string | null
  pendingInputMode: "replace" | "append" | "append-inline"
  /** Revert navigation text: only consumed if composer is currently empty. */
  pendingRevertText: string | null
  pendingSyntheticParts: SyntheticContextPart[] | null
  /**
   * Text a draft preset chip asked to submit immediately. Set by surfaces that
   * render the chips outside ChatInput (e.g. under the welcome message on
   * narrow layouts); consumed by ChatInput, which owns the command-aware submit.
   */
  pendingPresetSubmit: { text: string; type: "command" | "skill" } | null
  attachedFiles: AttachedFile[]

  setPendingInputText: (text: string | null, mode?: "replace" | "append" | "append-inline") => void
  consumePendingInputText: () => { text: string; mode: "replace" | "append" | "append-inline" } | null
  setPendingRevertText: (text: string | null) => void
  consumePendingRevertText: () => string | null
  requestPresetSubmit: (text: string, type: "command" | "skill") => void
  consumePendingPresetSubmit: () => { text: string; type: "command" | "skill" } | null
  setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => void
  consumePendingSyntheticParts: () => SyntheticContextPart[] | null
  addAttachedFile: (file: File) => Promise<boolean>
  removeAttachedFile: (id: string) => void
  setAttachedFiles: (files: AttachedFile[]) => void
  clearAttachedFiles: () => void
  /** Add attachments restored from a reverted message (file already on server) */
  addRestoredAttachment: (file: { url: string; mimeType: string; filename: string }) => void
}

export const useInputStore = create<InputState>()((set, get) => ({
  pendingInputText: null,
  pendingInputMode: "replace",
  pendingRevertText: null,
  pendingSyntheticParts: null,
  pendingPresetSubmit: null,
  attachedFiles: [],

  setPendingInputText: (text, mode = "replace") =>
    set({ pendingInputText: text, pendingInputMode: mode }),

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

  requestPresetSubmit: (text, type) => set({ pendingPresetSubmit: { text, type } }),

  consumePendingPresetSubmit: () => {
    const { pendingPresetSubmit } = get()
    if (pendingPresetSubmit === null) return null
    set({ pendingPresetSubmit: null })
    return pendingPresetSubmit
  },

  setPendingSyntheticParts: (parts) => set({ pendingSyntheticParts: parts }),

  consumePendingSyntheticParts: () => {
    const { pendingSyntheticParts } = get()
    if (pendingSyntheticParts !== null) {
      set({ pendingSyntheticParts: null })
    }
    return pendingSyntheticParts
  },

  addAttachedFile: async (file: File) => {
    const generation = attachmentReadGeneration
    for (let attempt = 0; attempt < MAX_ATTACHMENT_PREPARATION_ATTEMPTS; attempt += 1) {
      const reservedFilenames = get().attachedFiles.map((attachment) => attachment.filename)
      const preparedOrPending = prepareAttachmentFiles(file, reservedFilenames)
      const preparedFiles = preparedOrPending instanceof Promise ? await preparedOrPending : preparedOrPending
      if (!preparedFiles || preparedFiles.length === 0 || generation !== attachmentReadGeneration) return false

      const generatedFilenames = preparedFiles.slice(1).map((prepared) => prepared.file.name)
      if (hasGeneratedFilenameCollision(generatedFilenames, get().attachedFiles)) continue

      const attachedFiles: AttachedFile[] = []
      const isDocumentExtraction = preparedFiles.length > 1
      const sourceDocumentId = isDocumentExtraction ? `${Date.now()}-${Math.random().toString(36).slice(2)}` : undefined
      for (const prepared of preparedFiles) {
        let dataUrl: string
        try {
          dataUrl = await readFileAsDataUrl(prepared.file, prepared.mimeType)
        } catch {
          return false
        }
        if (!dataUrl || generation !== attachmentReadGeneration) return false
        attachedFiles.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file: prepared.file,
          dataUrl,
          mimeType: prepared.mimeType,
          filename: prepared.file.name,
          size: prepared.file.size,
          source: "local",
          sourceDocumentId,
        })
      }

      if (hasGeneratedFilenameCollision(generatedFilenames, get().attachedFiles)) continue
      set((state) => ({ attachedFiles: [...state.attachedFiles, ...attachedFiles] }))
      return true
    }
    return false
  },

  removeAttachedFile: (id) =>
    set((s) => {
      const target = s.attachedFiles.find((f) => f.id === id)
      if (target?.sourceDocumentId) {
        return { attachedFiles: s.attachedFiles.filter((f) => f.sourceDocumentId !== target.sourceDocumentId) }
      }
      return { attachedFiles: s.attachedFiles.filter((f) => f.id !== id) }
    }),

  setAttachedFiles: (files) => {
    attachmentReadGeneration += 1
    set({ attachedFiles: files })
  },

  clearAttachedFiles: () => {
    attachmentReadGeneration += 1
    set({ attachedFiles: [] })
  },

  addRestoredAttachment: ({ url, mimeType, filename }) => {
    const id = `restored-${Date.now()}-${Math.random().toString(36).slice(2)}`
    // Use "local" source so the file renders in AttachedFilesList.
    // Set serverPath to the URL so ImagePreview can use it as the img src
    // when dataUrl is not a data: URL. sanitizeAttachmentsForSend leaves
    // dataUrl alone for non-server sources, so the URL stays intact on send.
    const attached: AttachedFile = {
      id,
      file: new File([], filename, { type: mimeType }),
      dataUrl: url,
      mimeType,
      filename,
      size: getDataUrlByteSize(url),
      source: "local",
      serverPath: url,
    }
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
  },
}))
