/* eslint-disable */
/**
 * Session UI Store — ephemeral UI state only.
 *
 * Domain data (sessions, messages, parts, permissions, questions, status)
 * lives in sync child stores. This store owns ONLY transient UI concerns:
 * current selection, draft state, viewport anchors, model/agent preferences,
 * voice state, abort prompts, attached files, worktree metadata.
 *
 * Session↔worktree attachments are the authoritative exception: they live in
 * session-worktree-store (shared sync), and session-ui-store routes through it.
 *
 * Pi API actions that need domain data read it from sync-refs.
 */

import { create } from "zustand"
import type { Session, Part, Message, TextPart } from "@/lib/chat/types"
import type { AttachedFile, SessionContextUsage } from "@/stores/types/sessionTypes"
import { getPiSessionStore } from "@/apps/pi-session-store"
import { isPiThinkingLevel } from "@/lib/pi/thinking"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { useConfigStore } from "@/stores/useConfigStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { buildAvailableWorktreesByProject, useWorktreeStore } from "@/stores/useWorktreeStore"
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from "@/stores/useGlobalSessionsStore"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { useSkillsStore } from "@/stores/useSkillsStore"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { deriveSessionTitle } from "@/lib/chat/deriveSessionTitle"
import { normalizePath } from "@/lib/pathNormalization"
import { flattenAssistantTextParts } from "@/lib/messages/messageText"
import { composeForkSessionMessage } from "@/lib/messages/executionMeta"
import { findLatestUserModelChoice } from "@/lib/messages/userModelChoice"
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"
import {
  getSyncSessions,
  getAllSyncSessions,
  getSyncMessages,
  getSyncParts,
  getDirectoryState,
  getSyncSessionDirectory,
} from "./sync-refs"
import {
  resolveSessionDirectoryFromSources,
  type SessionDirectoryResolution,
  type SessionDirectorySources,
} from "./session-directory-resolution"
import { markSessionViewed } from "./notification-store"
import { setActiveSession } from "./sync-context"
import {
  createSession as createSessionAction,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  archiveSession as archiveSessionAction,
  archiveSessions as archiveSessionsAction,
  unarchiveSession as unarchiveSessionAction,
  unarchiveSessions as unarchiveSessionsAction,
  updateSessionTitle as updateSessionTitleAction,
  shareSession as shareSessionAction,
  unshareSession as unshareSessionAction,
  optimisticSend,
  refetchSessionMessages,
  revertToMessage as revertToMessageAction,
  restoreRevertedMessage as restoreRevertedMessageAction,
  unrevertSession as unrevertSessionAction,
  forkFromMessage as forkFromMessageAction,
  fetchMessagesForSession,
  type ArchiveSessionsOptions,
  type DeleteSessionOptions,
  type DeleteSessionsOptions,
  type UnarchiveSessionsOptions,
} from "./session-actions"
import { useInputStore, type SyntheticContextPart } from "./input-store"
import { useSelectionStore } from "./selection-store"
import { getViewportSessionMemory, useViewportStore, viewportSessionKey } from "./viewport-store"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { clearLastActiveSession, persistLastActiveSession, readLastActiveSession } from "./last-session-cache"
import { sanitizeFilename } from "@/lib/pi/attachments"

export type { AttachedFile }

// ---------------------------------------------------------------------------
// Send routing — shell mode, slash commands, or normal prompt
// ---------------------------------------------------------------------------

function committedSessionSelection(sessionId: string) {
  const state = getPiSessionStore().getState()
  const live = state.reducer.bySession.get(sessionId)
  const listed = state.sessions.find((item) => item.session.id === sessionId)?.session
  return {
    model: live?.model ?? listed?.model,
    thinking: live?.thinking ?? listed?.thinking,
  }
}

export async function routeMessage(params: {
  runtimeKey?: string
  sessionId: string
  directory?: string | null
  content: string
  providerID: string
  modelID: string
  agent?: string
  agentMentionName?: string
  variant?: string
  inputMode?: "normal" | "shell"
  files?: Array<{ type: "file"; mime: string; url: string; filename: string; uploadState?: AttachedFile["uploadState"] }>
  additionalParts?: Array<{ text: string; synthetic?: boolean; files?: Array<{ type: "file"; mime: string; url: string; filename: string; uploadState?: AttachedFile["uploadState"] }> }>
  delivery?: 'steer' | 'followUp' | 'prompt'
}): Promise<void> {
  const delivery = params.delivery === 'steer' || params.delivery === 'followUp' ? params.delivery : 'prompt'
  const sessionStore = getPiSessionStore()
  if (params.sessionId && params.providerID && params.modelID) {
    const currentModel = committedSessionSelection(params.sessionId).model
    if (!currentModel || currentModel.providerId !== params.providerID || currentModel.modelId !== params.modelID) {
      await sessionStore.setModel(params.sessionId, params.providerID, params.modelID)
    }
  }
  if (params.sessionId && isPiThinkingLevel(params.variant)) {
    const currentThinking = committedSessionSelection(params.sessionId).thinking
    if (currentThinking !== params.variant) {
      await sessionStore.setThinking(params.sessionId, params.variant)
    }
  }
  const outgoingFiles = [
    ...(params.files ?? []),
    ...(params.additionalParts ?? []).flatMap((part) => part.files ?? []),
  ].filter((file) => file.uploadState !== undefined || file.url.startsWith('data:'));
  const refreshedIds: string[] = [];
  try {
    const attachments = await Promise.all(outgoingFiles.map(async (file) => {
      const state = file.uploadState;
      if (state?.status === 'preparing' || state?.status === 'uploading') {
        throw new Error('Attachments are still uploading.');
      }
      if (state?.status === 'failed') {
        throw new Error('Retry or remove failed attachments.');
      }
      if (state?.status === 'ready' && state.expiresAt > Date.now()) {
        return { id: state.attachmentId };
      }
      // Persisted queue entries from before the upload lifecycle retain a data
      // URL. Refresh those, and expired ready entries, over the binary route.
      if (typeof file.url === 'string' && file.url.startsWith('data:')) {
        const response = await fetch(file.url);
        const blob = await response.blob();
        const attachment = await sessionStore.uploadFile(blob, {
          filename: sanitizeFilename(file.filename),
          mime: file.mime,
        });
        refreshedIds.push(attachment.id);
        return { id: attachment.id };
      }
      throw new Error('Attachment data is unavailable. Remove the attachment and add it again.');
    }));
    await sessionStore.prompt(params.sessionId, params.content, delivery, attachments.length > 0 ? attachments : undefined);
  } catch (error) {
    await Promise.all(refreshedIds.map((id) => sessionStore.deleteUpload(id).catch(() => undefined)));
    throw error;
  }
}

type CapturedSendTarget = {
  runtimeKey: string
  sessionId: string
  directory: string
}

export type DraftBranchCheckoutReceipt = {
  runtimeKey: string
  directory: string
  branch: string
}

type SendMessageOptions = {
  target?: CapturedSendTarget
  sessionId?: string
  directory?: string
  delivery?: 'steer'
  branchCheckoutReceipt?: DraftBranchCheckoutReceipt
  worktreeCreationReceipt?: DraftWorktreeCreationReceipt
  draftSnapshot?: NewSessionDraftState
}

type AssistantMessageSessionExecution = {
  providerID: string
  modelID: string
  variant: string
  agent: string
  instructions: string
}

// ---------------------------------------------------------------------------

export type DraftBranchIntent = {
  runtimeKey: string
  directory: string
  branch: string
}

export type DraftWorktreeIntent = {
  runtimeKey: string
  projectRoot: string
  sourceDirectory: string
  startRef: string
}

export type DraftWorktreeCreationReceipt = DraftWorktreeIntent & {
  path: string
  branch: string
}

type NewSessionDraftState = {
  open: boolean
  selectedProjectId?: string | null
  directoryOverride: string | null
  branchIntent?: DraftBranchIntent | null
  worktreeIntent?: DraftWorktreeIntent | null
  permissionAutoAcceptEnabled?: boolean
  preserveDirectoryOverride?: boolean
  parentID: string | null
  title?: string
  initialPrompt?: string
  syntheticParts?: SyntheticContextPart[]
  targetFolderId?: string
}

type ViewportAnchor = {
  sessionId: string
  value: number
}

type SessionHistoryMeta = {
  limit: number
  hasMore: boolean
  complete: boolean
  isLoading: boolean
  loading?: boolean
  nextCursor?: string
}

type SessionUIState = {
  currentSessionId: string | null
  currentSessionDirectory: string | null
  newSessionDraft: NewSessionDraftState
  abortPromptSessionId: string | null
  abortPromptExpiresAt: number | null
  error: string | null
  webUICreatedSessions: Set<string>
  sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean }>
  abortControllers: Map<string, AbortController>
  isLoading: boolean
  lastLoadedDirectory: string | null

  // Non-Git mode: dismissed signature hash per session, hides bar until new turn arrives
  pendingChangesBarDismissed: Map<string, string>
  dismissPendingChangesBar: (sessionId: string, signature: string | null) => void

  // Actions — UI state management
  setCurrentSession: (id: string | null, directoryHint?: string | null) => void
  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  openNewSessionDraft: (options?: Partial<NewSessionDraftState> & { automatic?: boolean }) => void
  closeNewSessionDraft: () => void
  setNewSessionDraftTarget: (target: { projectId?: string | null; selectedProjectId?: string | null; directoryOverride?: string | null; branchIntent?: DraftBranchIntent | null; worktreeIntent?: DraftWorktreeIntent | null }) => void
  setDraftPreserveDirectoryOverride: (value: boolean) => void
  setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void
  acknowledgeSessionAbort: (sessionId: string) => void
  clearAbortPrompt: () => void
  armAbortPrompt: (durationMs?: number) => number | null
  clearError: () => void
  markSessionAsPiChamberCreated: (sessionId: string) => void
  isPiChamberCreatedSession: (sessionId: string) => boolean
  getContextUsage: (contextLimit: number, outputLimit: number) => SessionContextUsage | null
  initializeNewPiChamberSession: (sessionId: string, agents: unknown[]) => void
  overrideNewSessionDraftTarget: (options: Record<string, unknown>) => void

  // Actions — Pi API operations (read domain data from sync-refs)
  sendMessage: (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => Promise<void>

  createSession: (
    title?: string,
    directoryOverride?: string | null,
    parentID?: string | null,
    metadata?: Record<string, unknown>,
    options?: { draftSnapshot?: NewSessionDraftState; closeDraft?: boolean },
  ) => Promise<Session | null>
  deleteSession: (id: string, options?: DeleteSessionOptions) => Promise<boolean>
  deleteSessions: (ids: string[], options?: DeleteSessionsOptions) => Promise<{ deletedIds: string[]; failedIds: string[] }>
  archiveSession: (id: string) => Promise<boolean>
  archiveSessions: (ids: string[], options?: ArchiveSessionsOptions) => Promise<{ archivedIds: string[]; failedIds: string[] }>
  unarchiveSession: (id: string) => Promise<boolean>
  unarchiveSessions: (ids: string[], options?: UnarchiveSessionsOptions) => Promise<{ restoredIds: string[]; failedIds: string[] }>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  shareSession: (sessionId: string) => Promise<Session | null>
  unshareSession: (sessionId: string) => Promise<Session | null>
  revertToMessage: (sessionId: string, messageId: string, options?: { skipRedoPush?: boolean }) => Promise<void>
  restoreToMessage: (sessionId: string, messageId: string) => Promise<void>
  forkFromMessage: (sessionId: string, messageId: string) => Promise<void>
  handleSlashUndo: (sessionId: string) => Promise<void>
  handleSlashRedo: (sessionId: string) => Promise<void>
  createSessionFromAssistantMessage: (sourceMessageId: string, execution: AssistantMessageSessionExecution) => Promise<void>

  // Data access helpers (read from sync)
  getSessionsByDirectory: (directory: string) => Session[]
  getDirectoryForSession: (sessionId: string) => string | null
  getLastUserChoice: (sessionId: string) => { agent?: string; providerID?: string; modelID?: string; variant?: string } | null
  getCurrentAgent: (sessionId: string) => string | undefined
  debugSessionMessages: (sessionId: string) => Promise<void>
  pollForTokenUpdates: () => void
  setSessionDirectory: (sessionId: string, directory: string | null) => void
  /**
   * Replace a guessed selection directory with the authoritative one once sync
   * has indexed the session. Safe to call at any time: it only ever promotes a
   * guess, never overrides a confirmed selection.
   */
  adoptAuthoritativeSessionDirectory: (sessionId?: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


const resolveDirectoryKey = (session: Session): string | null => {
  const sessionRecord = session as Session & {
    directory?: string | null
  }
  return normalizePath(sessionRecord.directory ?? null)
}

const safeStorage = getDeferredSafeStorage()
const DRAFT_TARGET_STORAGE_KEY = "oc.chatInput.lastDraftTarget"

type PersistedDraftTarget = { projectId: string | null; directory: string | null }

const readPersistedDraftTarget = (): PersistedDraftTarget | null => {
  try {
    const raw = safeStorage.getItem(DRAFT_TARGET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { projectId?: unknown; directory?: unknown }
    return {
      projectId: typeof parsed?.projectId === "string" ? parsed.projectId : null,
      directory: normalizePath(typeof parsed?.directory === "string" ? parsed.directory : null),
    }
  } catch {
    return null
  }
}

const persistDraftTarget = (target: PersistedDraftTarget): void => {
  try {
    safeStorage.setItem(DRAFT_TARGET_STORAGE_KEY, JSON.stringify(target))
  } catch { /* ignored */ }
}

const getAuthoritativeSessionDirectory = (sessionId: string): string | null => {
  const target = getAllSyncSessions().find((s) => s.id === sessionId)
  const recordDirectory = target ? resolveDirectoryKey(target) : null
  if (recordDirectory) return normalizePath(recordDirectory)
  const owningDirectory = getSyncSessionDirectory(sessionId)
  return owningDirectory ? normalizePath(owningDirectory) : null
}

export const getRememberedSessionDirectory = (sessionId: string): {
  runtime: string | null
  persisted: string | null
} => {
  const key = runtimeMemoryKey()
  const runtimeMemory = runtimeSessionMemory.get(key)
  const persisted = readLastActiveSession(key)
  return {
    runtime: runtimeMemory?.sessionId === sessionId ? normalizePath(runtimeMemory.directory) : null,
    persisted: persisted?.sessionId === sessionId ? normalizePath(persisted.directory) : null,
  }
}

let guessedSelectionSessionId: string | null = null

const collectSessionDirectorySources = (
  sessionId: string,
  selected: string | null,
): SessionDirectorySources => ({
  session: getAllSyncSessions().find((s) => s.id === sessionId) ?? null,
  currentDirectory: sessionId === guessedSelectionSessionId ? null : normalizePath(selected),
})

const resolveSessionDirectory = (
  sessionId: string | null | undefined,
  selected: string | null = null,
): string | null => {
  if (!sessionId) return null
  const resolution = resolveSessionDirectoryFromSources(
    collectSessionDirectorySources(sessionId, selected),
  )
  return resolution?.directory ?? null
}

const activateConfigForDirectory = async (directory: string | null | undefined): Promise<void> => {
  await useConfigStore.getState().activateDirectory(normalizePath(directory))
}

const DEFAULT_DRAFT: NewSessionDraftState = {
  open: false,
  directoryOverride: null,
  branchIntent: null,
  worktreeIntent: null,
  parentID: null,
}

export const draftBranchCheckoutReceiptMatches = (
  intent: DraftBranchIntent | null | undefined,
  receipt: DraftBranchCheckoutReceipt | null | undefined,
): boolean => {
  if (!intent || !receipt) return false
  return intent.runtimeKey === receipt.runtimeKey
    && normalizePath(intent.directory) === normalizePath(receipt.directory)
    && intent.branch === receipt.branch
}

const activeSessionByRuntime = new Map<string, string | null>()
type RuntimeSessionMemory = {
  sessionId: string | null
  directory: string | null
  draft: NewSessionDraftState
}
const runtimeSessionMemory = new Map<string, RuntimeSessionMemory>()

const runtimeMemoryKey = (value?: string | null): string => {
  const key = (value ?? getRuntimeKey()).trim()
  return key || "default"
}

const cloneDraft = (draft: NewSessionDraftState): NewSessionDraftState => ({ ...draft })

const writeRuntimeSessionMemory = (key: string, patch: Partial<RuntimeSessionMemory>): void => {
  const current = runtimeSessionMemory.get(key)
  runtimeSessionMemory.set(key, {
    sessionId: current?.sessionId ?? null,
    directory: current?.directory ?? null,
    draft: current?.draft ? cloneDraft(current.draft) : { ...DEFAULT_DRAFT },
    ...patch,
  })
}

type MaterializedDraftSession = {
  sessionId: string
  directory: string | null
  agent?: string
  syntheticParts?: SyntheticContextPart[]
}

const resolveProjectRefForWorktreeDirectory = (_directory: string | null, projectId?: string | null): { id: string; path: string } | null => {
  const projectsState = useProjectsStore.getState()
  if (projectId) {
    const project = projectsState.projects.find((entry) => entry.id === projectId)
    if (project?.path) return { id: project.id, path: project.path }
  }
  return null
}

const waitForWorktreeBootstrapIfConfigured = async (_directory: string | null, _projectId?: string | null): Promise<void> => {}

export async function materializeOpenDraftSession(selection: {
  providerID: string
  modelID: string
  agent?: string
  variant?: string
  initialPrompt?: string
  branchCheckoutReceipt?: DraftBranchCheckoutReceipt
  worktreeCreationReceipt?: DraftWorktreeCreationReceipt
  draftSnapshot?: NewSessionDraftState
}): Promise<MaterializedDraftSession | null> {
  const store = useSessionUIStore.getState()
  const draft = selection.draftSnapshot ?? store.newSessionDraft
  if (!draft?.open) return null
  if (draft.branchIntent) {
    const branchDirectory = normalizePath(draft.branchIntent.directory)
    const draftDirectory = normalizePath(draft.directoryOverride)
    if (draft.branchIntent.runtimeKey !== getRuntimeKey() || branchDirectory !== draftDirectory) {
      throw new Error("The selected branch no longer matches this draft target.")
    }
    if (!draftBranchCheckoutReceiptMatches(draft.branchIntent, selection.branchCheckoutReceipt)) {
      throw new Error("Confirm the selected branch before creating this session.")
    }
  }
  if (draft.worktreeIntent) {
    const receipt = selection.worktreeCreationReceipt
    if (
      !receipt
      || receipt.runtimeKey !== draft.worktreeIntent.runtimeKey
      || normalizePath(receipt.projectRoot) !== normalizePath(draft.worktreeIntent.projectRoot)
      || normalizePath(receipt.sourceDirectory) !== normalizePath(draft.worktreeIntent.sourceDirectory)
      || receipt.startRef !== draft.worktreeIntent.startRef
      || !normalizePath(receipt.path)
    ) {
      throw new Error("Create the selected worktree before creating this session.")
    }
  }
  const draftPermissionAutoAcceptEnabled = draft.permissionAutoAcceptEnabled === true

  const trimmedAgent = typeof selection.agent === "string" && selection.agent.trim().length > 0
    ? selection.agent.trim()
    : undefined
  const draftDirectoryOverride = selection.worktreeCreationReceipt?.path ?? draft.directoryOverride ?? null
  const draftProjectId = draft.selectedProjectId ?? null

  const derivedTitle = draft.title || (selection.initialPrompt ? deriveSessionTitle(selection.initialPrompt) : undefined)

  const created = await store.createSession(
    derivedTitle,
    draftDirectoryOverride,
    draft.parentID ?? null,
    {
      model: selection.providerID && selection.modelID ? { providerId: selection.providerID, modelId: selection.modelID } : undefined,
      thinking: isPiThinkingLevel(selection.variant) ? selection.variant : undefined,
      select: false,
    },
    {
      draftSnapshot: draft,
      closeDraft: false,
    },
  )
  if (!created?.id) throw new Error("Failed to create session")

  const createdDirectory = normalizePath(created.directory ?? draftDirectoryOverride ?? null)
  const shouldActivateCreatedSession = (
    useSessionUIStore.getState().newSessionDraft === draft
    && useSessionUIStore.getState().currentSessionId === null
  )

  if (shouldActivateCreatedSession) {
    persistDraftTarget({
      projectId: draftProjectId,
      directory: createdDirectory,
    })
  }

  const draftSyntheticParts = draft.syntheticParts
  const configState = useConfigStore.getState()
  if (shouldActivateCreatedSession) {
    void activateConfigForDirectory(createdDirectory).catch((error) => {
      console.warn("Failed to activate directory after creating session:", error)
    })
  }

  const effectiveDraftAgent = trimmedAgent ?? configState.currentAgentName

  useSelectionStore.getState().saveSessionModelSelection(created.id, selection.providerID, selection.modelID)

  if (effectiveDraftAgent) {
    useSelectionStore.getState().saveSessionAgentSelection(created.id, effectiveDraftAgent)
    useSelectionStore.getState().saveAgentModelForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID)
    useSelectionStore.getState().saveAgentModelVariantForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID, selection.variant)
  }

  store.initializeNewPiChamberSession(created.id, configState.agents ?? [])

  if (shouldActivateCreatedSession) {
    store.setCurrentSession(created.id, createdDirectory)
  }

  if (draftPermissionAutoAcceptEnabled) {
    void import("@/stores/permissionStore")
      .then(({ usePermissionStore }) => usePermissionStore.getState().setSessionAutoAccept(created.id, true))
      .catch((error) => {
        console.warn("Failed to apply draft permission auto-accept to new session:", error)
      })
  }

  return {
    sessionId: created.id,
    directory: createdDirectory,
    agent: effectiveDraftAgent,
    syntheticParts: draftSyntheticParts,
  }
}

export const useSessionUIStore = create<SessionUIState>()((set, get) => ({
  currentSessionId: null,
  currentSessionDirectory: null,
  newSessionDraft: { ...DEFAULT_DRAFT },
  abortPromptSessionId: null,
  abortPromptExpiresAt: null,
  error: null,
  webUICreatedSessions: new Set(),
  sessionAbortFlags: new Map(),
  abortControllers: new Map(),
  isLoading: false,
  lastLoadedDirectory: null,
  pendingChangesBarDismissed: new Map(),

  // ---------------------------------------------------------------------------
  // setCurrentSession
  // ---------------------------------------------------------------------------
  setCurrentSession: (id, directoryHint?: string | null) => {
    if (id) {
      get().closeNewSessionDraft()
    }

    const key = runtimeMemoryKey()
    activeSessionByRuntime.set(key, id)

    const previousSessionId = get().currentSessionId
    const directoryState = useDirectoryStore.getState()

    const sessionDir = resolveSessionDirectory(id)
    const fallbackDir = getPiSessionStore().getState().directory ?? directoryState.currentDirectory ?? null
    const knownDir = (directoryHint ? normalizePath(directoryHint) : null) ?? sessionDir
    const resolvedDir = knownDir ?? fallbackDir
    const isGuessedDir = knownDir === null
    const projectsState = useProjectsStore.getState()
    const sessionProject = resolvedDir
      ? resolveProjectForSessionDirectory(
        projectsState.projects,
        buildAvailableWorktreesByProject(projectsState.projects, useWorktreeStore.getState()),
        resolvedDir,
      )
      : null

    // Set the directory together with the session id so chat hooks read the
    // same child store that send/SSE events will update during startup races.
    set({ currentSessionId: id, currentSessionDirectory: id ? resolvedDir ?? null : null })
    guessedSelectionSessionId = isGuessedDir && id ? id : null
    const rememberedDir = isGuessedDir ? null : resolvedDir ?? null
    writeRuntimeSessionMemory(key, { sessionId: id, directory: rememberedDir })
    // Keep the last NON-null session per runtime across app restarts (cold
    // mobile launches reopen it after the instance reconnects). Going back to
    // a draft intentionally does not erase it.
    if (id) {
      persistLastActiveSession(key, { sessionId: id, directory: rememberedDir })
    }

    // Kick off the session selection and message hydration on the same tick,
    // before React commits the state change and fires ChatContainer.useEffect.
    // Only pass the directory when it is authoritative (from stored session memory
    // or an explicit caller hint). When the directory is just a fallback guess
    // (e.g. the current active-project path), passing it causes select() to call
    // open(wrongDirectory, sessionId), which then has to rediscover the real
    // directory via getSession/findPersistedSession — wasting round-trips and
    // thrashing the daemon's activeDirectory. Passing undefined instead lets
    // select() hit the connection=loading early-return and defer to PiSessionProvider
    // start() which resolves the authoritative directory via getSession.
    if (id) {
      void getPiSessionStore().select(id, isGuessedDir ? undefined : resolvedDir)
    }

    try {
      if (resolvedDir && directoryState.currentDirectory !== resolvedDir) {
        directoryState.setDirectory(resolvedDir, { showOverlay: false })
      }
      if (sessionProject && projectsState.activeProjectId !== sessionProject.id) {
        projectsState.setActiveProjectIdOnly(sessionProject.id)
      }
    } catch (e) {
      console.warn("Failed to set Pi directory for session switch:", e)
    }

    // Defer viewport anchor save for previous session — not needed for the
    // skeleton to render and reads messages which can be expensive.
    if (previousSessionId && previousSessionId !== id) {
      const prevId = previousSessionId
      setTimeout(() => {
        const memState = getViewportSessionMemory(prevId)
        if (!memState?.isStreaming) {
          const prevMessages = getSyncMessages(prevId)
          if (prevMessages.length > 0) {
            useViewportStore.getState().updateViewportAnchor(prevId, prevMessages.length - 1)
          }
        }
      }, 0)
    }

    // Mark session viewed in notification store + update active session ref
    if (id) {
      markSessionViewed(id)
      setActiveSession(resolvedDir ?? "", id)
    }
  },

  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const directory = useDirectoryStore.getState().currentDirectory || null
    const currentSessionId = get().currentSessionId
    activeSessionByRuntime.set(key, get().currentSessionId)
    writeRuntimeSessionMemory(key, {
      sessionId: currentSessionId,
      directory,
      draft: cloneDraft(get().newSessionDraft),
    })
  },

  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const memory = runtimeSessionMemory.get(key)
    const restoredSessionId = memory?.sessionId ?? activeSessionByRuntime.get(key) ?? null
    const restoredDraft = memory?.draft ? cloneDraft(memory.draft) : { ...DEFAULT_DRAFT }
    const restoredDirectory = memory?.directory ?? null
    if (restoredDirectory) {
      useDirectoryStore.getState().setDirectory(restoredDirectory, { showOverlay: false })
    }
    set({
      currentSessionId: restoredSessionId,
      currentSessionDirectory: restoredSessionId ? restoredDirectory : null,
      newSessionDraft: restoredSessionId ? { ...DEFAULT_DRAFT } : restoredDraft,
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
      error: null,
      sessionAbortFlags: new Map(),
      pendingChangesBarDismissed: new Map(),
    })
    if (restoredSessionId) {
      setActiveSession(restoredDirectory ?? getPiSessionStore().getState().directory ?? "", restoredSessionId)
    } else {
      setActiveSession("", "")
    }
  },

  // ---------------------------------------------------------------------------
  // openNewSessionDraft
  // ---------------------------------------------------------------------------
  openNewSessionDraft: (options) => {
    // A USER-initiated draft open is a navigation choice: the next cold launch
    // should land on the draft, not re-open the session left behind — drop the
    // persisted last-session pointer for this runtime. `automatic: true` marks
    // programmatic fallback opens (e.g. ChatContainer's "no session active"
    // auto-draft at boot), which must NOT consume the pointer — the cold-launch
    // restore races exactly that auto-open.
    if (!options?.automatic) {
      clearLastActiveSession(runtimeMemoryKey())
    }
    const projectsState = useProjectsStore.getState()
    const projects = projectsState.projects
    const availableWorktreesByProject = buildAvailableWorktreesByProject(projects, useWorktreeStore.getState())
    const activeProject = projectsState.getActiveProject()
    const currentDirectory = normalizePath(useDirectoryStore.getState().currentDirectory ?? null)
    const persistedTarget = readPersistedDraftTarget()

    const GLOBAL_PROJECT_ID = '__home__'
    const isGlobalExplicit = options?.selectedProjectId === GLOBAL_PROJECT_ID
    const explicitDirectory = options?.directoryOverride !== undefined
      ? normalizePath(options.directoryOverride)
      : null
    const explicitProject = options?.selectedProjectId
      ? (isGlobalExplicit ? { id: GLOBAL_PROJECT_ID, path: explicitDirectory ?? '' } as unknown as typeof projects[number] : projects.find((p) => p.id === options.selectedProjectId) ?? null)
      : null

    const inferredProjectFromDir = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, explicitDirectory)
    const fallbackProject = (() => {
      if (activeProject) return activeProject
      if (projectsState.activeProjectId) return projects.find((p) => p.id === projectsState.activeProjectId) ?? null
      return projects[0] ?? null
    })()

    const isPersistedGlobal = persistedTarget?.projectId === GLOBAL_PROJECT_ID
    const persistedProjectById = persistedTarget?.projectId
      ? (isPersistedGlobal ? { id: GLOBAL_PROJECT_ID, path: persistedTarget.directory ?? '' } as unknown as typeof projects[number] : projects.find((p) => p.id === persistedTarget.projectId) ?? null)
      : null
    const persistedProjectByDir = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, persistedTarget?.directory ?? null)
    const currentDirProject = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, currentDirectory)

    const selectedProject = (() => {
      if (isGlobalExplicit) return explicitProject
      if (explicitProject) return explicitProject
      if (explicitDirectory !== null) return inferredProjectFromDir
      if (currentDirectory) return currentDirProject
      if (isPersistedGlobal) return persistedProjectById
      return persistedProjectByDir ?? persistedProjectById ?? fallbackProject
    })()

    const directory = (() => {
      if (explicitDirectory !== null) return explicitDirectory
      if (isGlobalExplicit) return explicitDirectory ?? normalizePath((useDirectoryStore.getState().homeDirectory || getDeferredSafeStorage().getItem('homeDirectory') || '~') as string) ?? explicitDirectory
      if (explicitProject) return normalizePath(explicitProject.path ?? null)
      if (currentDirectory) return currentDirectory
      if (persistedTarget?.directory) return persistedTarget.directory
      return normalizePath(selectedProject?.path ?? null)
    })()

    const draftSelectedProjectId = isGlobalExplicit ? GLOBAL_PROJECT_ID : (selectedProject?.id ?? null)
    persistDraftTarget({ projectId: draftSelectedProjectId, directory })

    const nextDraft: NewSessionDraftState = {
      open: true,
      selectedProjectId: draftSelectedProjectId,
      directoryOverride: directory,
      branchIntent: options?.branchIntent
        && options.branchIntent.runtimeKey === getRuntimeKey()
        && normalizePath(options.branchIntent.directory) === directory
          ? options.branchIntent
          : null,
      worktreeIntent: options?.worktreeIntent
        && options.worktreeIntent.runtimeKey === getRuntimeKey()
        && normalizePath(options.worktreeIntent.sourceDirectory) === directory
          ? options.worktreeIntent
          : null,
      permissionAutoAcceptEnabled: options?.permissionAutoAcceptEnabled === true,
      preserveDirectoryOverride: options?.preserveDirectoryOverride === true,
      parentID: options?.parentID ?? null,
      title: options?.title,
      initialPrompt: options?.initialPrompt,
      syntheticParts: options?.syntheticParts,
      targetFolderId: options?.targetFolderId,
    }

    set({
      newSessionDraft: {
        ...nextDraft,
      },
      currentSessionId: null,
      currentSessionDirectory: null,
      error: null,
    })

    writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: null, directory, draft: nextDraft })
    // Clear composer attachments when opening a new session draft.
    // Attachments from the previous session (e.g. restored by revert) must
    // not bleed into the new session's input.
    useInputStore.getState().clearAttachedFiles()

    if (options?.initialPrompt) {
      useInputStore.getState().setPendingInputText(options.initialPrompt)
    }

    // Config (providers/agents/default model+agent) lives at the PROJECT level. When the user
    // came from a worktree session, `directory` is the worktree path, whose provider list does
    // not include every runtime-scoped provider
    // — resolving defaults against it could pick the wrong fallback model. Activate
    // the project's config instead so the default cascade matches app startup, then re-apply it
    // (a fresh draft must start from defaults, not inherit the previous session's selection).
    const configDirectory = normalizePath(selectedProject?.path ?? null) ?? directory
    void activateConfigForDirectory(configDirectory).then(() => {
      useConfigStore.getState().applyDefaultModelAgentSelection({
        projectDefaultModel: selectedProject?.defaultModel,
      })
    })

    if (directory && directory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(directory)
    }
  },

  // ---------------------------------------------------------------------------
  // closeNewSessionDraft
  // ---------------------------------------------------------------------------
  closeNewSessionDraft: () => {
    const currentDraft = get().newSessionDraft
    if (
      !currentDraft.open
      && currentDraft.selectedProjectId == null
      && currentDraft.directoryOverride == null
      && currentDraft.branchIntent == null
      && currentDraft.worktreeIntent == null
      && !currentDraft.preserveDirectoryOverride
      && currentDraft.parentID == null
      && currentDraft.title === undefined
      && currentDraft.initialPrompt === undefined
      && currentDraft.syntheticParts === undefined
      && currentDraft.targetFolderId === undefined
      && currentDraft.permissionAutoAcceptEnabled === undefined
    ) {
      return
    }
    const nextDraft: NewSessionDraftState = {
        open: false,
        selectedProjectId: null,
        directoryOverride: null,
        branchIntent: null,
        worktreeIntent: null,
        preserveDirectoryOverride: false,
        parentID: null,
        title: undefined,
        initialPrompt: undefined,
        syntheticParts: undefined,
        targetFolderId: undefined,
      }
    set({
      newSessionDraft: nextDraft,
    })
    writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: nextDraft })
  },

  setNewSessionDraftTarget: (target) => {
    let nextDirectory: string | null = null
    let nextProjectId: string | null = null
    set((s) => {
      nextDirectory = normalizePath(target.directoryOverride ?? s.newSessionDraft.directoryOverride)
      nextProjectId = target.projectId ?? target.selectedProjectId ?? s.newSessionDraft.selectedProjectId ?? null
      const hasBranchIntent = Object.prototype.hasOwnProperty.call(target, "branchIntent")
      const hasWorktreeIntent = Object.prototype.hasOwnProperty.call(target, "worktreeIntent")
      const currentDirectory = normalizePath(s.newSessionDraft.directoryOverride)
      const directoryChanged = nextDirectory !== currentDirectory
      const projectChanged = nextProjectId !== (s.newSessionDraft.selectedProjectId ?? null)
      const requestedBranchIntent = target.branchIntent
      const validRequestedBranchIntent = requestedBranchIntent
        && requestedBranchIntent.runtimeKey === getRuntimeKey()
        && normalizePath(requestedBranchIntent.directory) === nextDirectory
          ? requestedBranchIntent
          : null
      const requestedWorktreeIntent = target.worktreeIntent
      const validRequestedWorktreeIntent = requestedWorktreeIntent
        && requestedWorktreeIntent.runtimeKey === getRuntimeKey()
        && normalizePath(requestedWorktreeIntent.sourceDirectory) === nextDirectory
          ? requestedWorktreeIntent
          : null
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          selectedProjectId: nextProjectId,
          directoryOverride: target.directoryOverride ?? s.newSessionDraft.directoryOverride,
          branchIntent: hasBranchIntent
            ? validRequestedBranchIntent
            : directoryChanged || projectChanged
              ? null
              : s.newSessionDraft.branchIntent,
          worktreeIntent: hasWorktreeIntent
            ? validRequestedWorktreeIntent
            : directoryChanged || projectChanged
              ? null
              : s.newSessionDraft.worktreeIntent,
        },
      }
    })
    persistDraftTarget({ projectId: nextProjectId, directory: nextDirectory })
    void activateConfigForDirectory(nextDirectory)

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  setDraftPreserveDirectoryOverride: (value) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, preserveDirectoryOverride: value } }
    }),

  setDraftPermissionAutoAcceptEnabled: (enabled) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, permissionAutoAcceptEnabled: enabled } }
    }),

  acknowledgeSessionAbort: (sessionId) =>
    set((s) => {
      const flags = new Map(s.sessionAbortFlags)
      const existing = flags.get(sessionId)
      if (existing) flags.set(sessionId, { ...existing, acknowledged: true })
      return { sessionAbortFlags: flags }
    }),

  clearAbortPrompt: () => set({ abortPromptSessionId: null, abortPromptExpiresAt: null }),

  armAbortPrompt: (durationMs = 5000) => {
    const { currentSessionId } = get()
    if (!currentSessionId) return null
    const expiresAt = Date.now() + durationMs
    set({ abortPromptSessionId: currentSessionId, abortPromptExpiresAt: expiresAt })
    return expiresAt
  },

  clearError: () => set({ error: null }),

  markSessionAsPiChamberCreated: (sessionId) =>
    set((s) => {
      const next = new Set(s.webUICreatedSessions)
      next.add(sessionId)
      return { webUICreatedSessions: next }
    }),

  isPiChamberCreatedSession: (sessionId) => get().webUICreatedSessions.has(sessionId),

  getContextUsage: (contextLimit: number, outputLimit: number) => {
    if (get().newSessionDraft?.open) return null
    const sessionId = get().currentSessionId
    if (!sessionId) return null

    const messages = getSyncMessages(sessionId)
    if (messages.length === 0) return null

    type AssistantTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    let lastTokens: AssistantTokens | undefined
    let lastMessageId: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "assistant") continue
      const tokens = (msg as { tokens?: AssistantTokens }).tokens
      if (!tokens) continue
      const total = tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
      if (total > 0) {
        lastTokens = tokens
        lastMessageId = msg.id
        break
      }
    }

    if (!lastTokens) return null

    const totalTokens = lastTokens.input + lastTokens.output + lastTokens.reasoning + (lastTokens.cache?.read ?? 0) + (lastTokens.cache?.write ?? 0)
    const thresholdLimit = contextLimit > 0 ? contextLimit : 200000
    const percentage = contextLimit > 0 ? Math.round((totalTokens / contextLimit) * 100) : 0
    const normalizedOutput = outputLimit > 0 ? Math.round((lastTokens.output / outputLimit) * 100) : undefined

    return {
      totalTokens,
      percentage,
      contextLimit: contextLimit || 0,
      outputLimit: outputLimit || undefined,
      normalizedOutput,
      thresholdLimit,
      lastMessageId,
    }
  },

  initializeNewPiChamberSession: () => {
    // Stub — was a no-op in old store
  },

  overrideNewSessionDraftTarget: (options) => {
    let nextDirectory: string | null = null
    set((s) => {
      const nextDraft = { ...s.newSessionDraft, ...options }
      nextDirectory = normalizePath(
        typeof nextDraft.directoryOverride === "string" ? nextDraft.directoryOverride : null,
      )
      const currentDirectory = normalizePath(s.newSessionDraft.directoryOverride)
      if (
        nextDirectory !== currentDirectory
        && !Object.prototype.hasOwnProperty.call(options, "branchIntent")
      ) {
        nextDraft.branchIntent = null
      }
      return { newSessionDraft: nextDraft }
    })
    void activateConfigForDirectory(nextDirectory)

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  dismissPendingChangesBar: (sessionId, signature) => {
    const map = new Map(get().pendingChangesBarDismissed);
    if (signature === null) {
      map.delete(sessionId);
    } else {
      map.set(sessionId, signature);
    }
    set({ pendingChangesBarDismissed: map });
  },

  // ---------------------------------------------------------------------------
  // sendMessage — calls the Pi API, reads domain data from sync
  // ---------------------------------------------------------------------------
  // Armed goal (composer target button): the sent prompt becomes the goal
  // objective; budget comes from the global default setting. Fire-and-forget —
  // a failed metadata patch must not fail the send.
  sendMessage: async (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => {
    const capturedTarget = options?.target
    if (capturedTarget && capturedTarget.runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }

    // Clear non-Git changed-files bar on new user message for current session.
    // A captured draft owns its destination even if another session is current now.
    const sid = capturedTarget?.sessionId
      ?? options?.sessionId
      ?? (options?.draftSnapshot ? null : get().currentSessionId);
    if (sid) {
      const map = new Map(get().pendingChangesBarDismissed);
      map.delete(sid);
      set({ pendingChangesBarDismissed: map });
    }

    const draft = get().newSessionDraft
    const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined

    // ---- New session from draft ----
    if (!capturedTarget && !options?.sessionId && (options?.draftSnapshot?.open || draft?.open)) {
      const createdDraftSession = await materializeOpenDraftSession({
        providerID,
        modelID,
        agent: trimmedAgent,
        variant,
        initialPrompt: content,
        branchCheckoutReceipt: options?.branchCheckoutReceipt,
        worktreeCreationReceipt: options?.worktreeCreationReceipt,
        draftSnapshot: options?.draftSnapshot,
      })
      if (!createdDraftSession) throw new Error("Failed to create session")

      const mergedAdditionalParts = createdDraftSession.syntheticParts?.length
        ? [...(additionalParts || []), ...createdDraftSession.syntheticParts]
        : additionalParts

      markPendingUserSendAnimation(createdDraftSession.sessionId)

      const files = attachments?.map((a) => ({
        type: "file" as const,
        mime: a.mimeType,
        url: a.dataUrl,
        filename: a.filename,
        uploadState: a.uploadState,
      }))

      await routeMessage({
        sessionId: createdDraftSession.sessionId,
        directory: createdDraftSession.directory,
        content,
        providerID,
        modelID,
        agent: createdDraftSession.agent,
        agentMentionName,
        variant,
        inputMode,
        files,
        delivery: options?.delivery,
        additionalParts: mergedAdditionalParts?.map((p) => ({
          text: p.text,
          synthetic: p.synthetic,
          files: p.attachments?.map((a: AttachedFile) => ({
            type: "file" as const,
            mime: a.mimeType,
            url: a.dataUrl,
            filename: a.filename,
            uploadState: a.uploadState,
          })),
        })),
      })
      return
    }

    // ---- Existing session ----
    const targetSessionId = capturedTarget?.sessionId ?? options?.sessionId ?? get().currentSessionId
    const sessionAgentSelection = targetSessionId
      ? useSelectionStore.getState().getSessionAgentSelection(targetSessionId)
      : null
    const configAgentName = useConfigStore.getState().currentAgentName
    const effectiveAgent = trimmedAgent || sessionAgentSelection || configAgentName || undefined

    if (targetSessionId) {
      useSelectionStore.getState().saveSessionModelSelection(targetSessionId, providerID, modelID)
    }

    if (targetSessionId && effectiveAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(targetSessionId, effectiveAgent)
      useSelectionStore.getState().saveAgentModelForSession(targetSessionId, effectiveAgent, providerID, modelID)
      useSelectionStore.getState().saveAgentModelVariantForSession(targetSessionId, effectiveAgent, providerID, modelID, variant)
    }

    if (targetSessionId) {
      const viewportState = useViewportStore.getState()
      const memState = getViewportSessionMemory(targetSessionId)
      if (!memState || !memState.lastUserMessageAt) {
        const newMemState = new Map(viewportState.sessionMemoryState)
        newMemState.set(viewportSessionKey(targetSessionId), {
          viewportAnchor: 0,
          isStreaming: false,
          lastAccessedAt: Date.now(),
          backgroundMessageCount: 0,
          ...memState,
          lastUserMessageAt: Date.now(),
        })
        useViewportStore.setState({ sessionMemoryState: newMemState })
      }
    }

    const currentSessionDirectory = targetSessionId
      ? normalizePath(capturedTarget?.directory ?? options?.directory ?? get().getDirectoryForSession(targetSessionId))
      : null
    if (targetSessionId) {
      markPendingUserSendAnimation(targetSessionId)
    }

    const files = attachments?.map((a) => ({
      type: "file" as const,
      mime: a.mimeType,
      url: a.dataUrl,
      filename: a.filename,
      uploadState: a.uploadState,
    }))

    await routeMessage({
      runtimeKey: capturedTarget?.runtimeKey,
      sessionId: targetSessionId || "",
      directory: currentSessionDirectory,
      content,
      providerID,
      modelID,
      agent: effectiveAgent,
      agentMentionName,
      variant,
      inputMode,
      files,
      delivery: options?.delivery,
      additionalParts: additionalParts?.map((p) => ({
        text: p.text,
        synthetic: p.synthetic,
        files: p.attachments?.map((a) => ({
          type: "file" as const,
          mime: a.mimeType,
          url: a.dataUrl,
          filename: a.filename,
          uploadState: a.uploadState,
        })),
      })),
    })
  },

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------
  createSession: async (title, directoryOverride, parentID, metadata, options) => {
    const draft = options?.draftSnapshot ?? get().newSessionDraft
    const targetFolderId = draft.targetFolderId

    try {
      const dir = directoryOverride ?? getPiSessionStore().getState().directory
      const session = await createSessionAction(title, dir, parentID ?? null, metadata)
      if (!session) return null

      if (options?.closeDraft !== false && get().newSessionDraft === draft) {
        get().closeNewSessionDraft()
      }

      if (targetFolderId) {
        const scopeKey = directoryOverride || get().lastLoadedDirectory || session.directory
        if (scopeKey) {
          useSessionFoldersStore.getState().addSessionToFolder(scopeKey, targetFolderId, session.id)
        }
      }

      return session
    } catch (e) {
      console.error("[session-ui-store] createSession failed", e)
      return null
    }
  },

  // ---------------------------------------------------------------------------
  // deleteSession — calls the Pi API, SSE event updates child store
  // ---------------------------------------------------------------------------
  deleteSession: (id, options) => deleteSessionAction(id, options as any),

  deleteSessions: (ids, options) => deleteSessionsAction(ids, options as any),

  archiveSession: (id) => archiveSessionAction(id),

  archiveSessions: (ids, options) => archiveSessionsAction(ids, options as any),

  unarchiveSession: (id) => unarchiveSessionAction(id),

  unarchiveSessions: (ids, options) => unarchiveSessionsAction(ids, options as any),

  // ---------------------------------------------------------------------------
  // updateSessionTitle — calls the Pi API, SSE event updates child store
  // ---------------------------------------------------------------------------
  updateSessionTitle: async (sessionId, title) => {
    await updateSessionTitleAction(sessionId, title)
  },

  shareSession: async (sessionId) => {
    return shareSessionAction(sessionId)
  },

  unshareSession: async (sessionId) => {
    return unshareSessionAction(sessionId)
  },

  // ---------------------------------------------------------------------------
  // revertToMessage — delegates to session-actions (single implementation)
  // ---------------------------------------------------------------------------
  revertToMessage: async (sessionId, messageId) => {
    // Ensure the complete message range is present before applying the revert
    // marker. Reverted UI is derived from session.revert + stored messages.
    await refetchSessionMessages(sessionId)
    await revertToMessageAction(sessionId, messageId)
  },

  // ---------------------------------------------------------------------------
  // restoreToMessage — advances within the abandoned branch without editing
  // ---------------------------------------------------------------------------
  restoreToMessage: async (sessionId, messageId) => {
    await restoreRevertedMessageAction(sessionId, messageId)
  },

  // ---------------------------------------------------------------------------
  // handleSlashUndo — Pi-native: revert to previous user message
  // ---------------------------------------------------------------------------
  handleSlashUndo: async (sessionId) => {
    const reducerState = getPiSessionStore().getState().reducer.bySession.get(sessionId);
    const messages = reducerState ? [...reducerState.messages.values()] : [];
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) return;
    const targetMessage = userMessages[userMessages.length - 1];
    if (!targetMessage) return;
    const preview = String(targetMessage.text ?? '').slice(0, 50) + ((targetMessage.text?.length ?? 0) > 50 ? "..." : "") || "[No text]";
    await get().revertToMessage(sessionId, targetMessage.id);
    const { toast } = await import("sonner");
    toast.success(`Reverted — conversation rewound. Files on disk were not changed.`);
    void preview;
  },

  // ---------------------------------------------------------------------------
  // handleSlashRedo — Pi-native: navigate to saved previous leaf
  // ---------------------------------------------------------------------------
  handleSlashRedo: async (sessionId) => {
    await unrevertSessionAction(sessionId)
    const { toast } = await import("sonner");
    toast.success("Restored all messages");
  },

  // ---------------------------------------------------------------------------
  // forkFromMessage — delegates to session-actions; callers own presentation
  // ---------------------------------------------------------------------------
  forkFromMessage: async (sessionId, messageId) => {
    await forkFromMessageAction(sessionId, messageId)
  },

  // ---------------------------------------------------------------------------
  // createSessionFromAssistantMessage — reads from sync
  // ---------------------------------------------------------------------------
  createSessionFromAssistantMessage: async (sourceMessageId, execution) => {
    if (!sourceMessageId) return
    if (!execution?.instructions?.trim()) return

    // Find which session this message belongs to by scanning sync state
    const state = getDirectoryState()
    if (!state) return

    let sourceSessionId: string | undefined
    let sourceMessage: Message | undefined

    for (const [sid, msgs] of Object.entries((state as any).message ?? {})) {
      const found = (msgs as any[])?.find((m: any) => m.id === sourceMessageId)
      if (found) {
        sourceSessionId = sid
        sourceMessage = found
        break
      }
    }

    if (!sourceMessage || sourceMessage.role !== "assistant") return

    const sourceParts = getSyncParts(sourceMessageId)
    const assistantPlanText = flattenAssistantTextParts(sourceParts)
    if (!assistantPlanText.trim()) return

    const directory = resolveSessionDirectory(sourceSessionId ?? null)
    const pID = execution.providerID || useSelectionStore.getState().lastUsedProvider?.providerID
    const mID = execution.modelID || useSelectionStore.getState().lastUsedProvider?.modelID

    if (!pID || !mID) return

    const sourceDirectory = normalizePath(directory ?? getPiSessionStore().getState().directory ?? null)
    const session = await get().createSession(undefined, sourceDirectory || null, null)
    if (!session) return

    await get().sendMessage(
      composeForkSessionMessage(execution.instructions, assistantPlanText),
      pID,
      mID,
      execution.agent || undefined,
      undefined,
      undefined,
      undefined,
      execution.variant || undefined,
      undefined,
      { sessionId: session.id },
    )
  },

  // ---------------------------------------------------------------------------
  // Data access helpers — read from sync
  // ---------------------------------------------------------------------------
  getSessionsByDirectory: (directory) => {
    const nd = normalizePath(directory)
    if (!nd) return []
    const sessions = getAllSyncSessions()
    return sessions.filter((s) => resolveDirectoryKey(s) === nd)
  },

  getDirectoryForSession: (sessionId) => {
    // The selection-time directory participates in resolution, it does not
    // short-circuit it. For a worktree session selected before its directory
    // store finished bootstrapping, that value is a startup fallback pointing
    // at the parent repository; letting it win would route every send, queue
    // key, and send-confirmation lookup to a directory that does not own the
    // session.
    const selected = sessionId === get().currentSessionId ? get().currentSessionDirectory : null
    const resolved = resolveSessionDirectory(
      sessionId,
      selected,
    )
    if (resolved) return resolved
    const globalStore = useGlobalSessionsStore.getState()
    const globalSession = [...globalStore.activeSessions, ...globalStore.archivedSessions]
      .find((s) => s.id === sessionId)
    if (globalSession) return resolveGlobalSessionDirectory(globalSession)
    return null
  },

  getLastUserChoice: (sessionId) => {
    const directory = get().getDirectoryForSession(sessionId) ?? undefined
    const messages = getSyncMessages(sessionId, directory)
    const choice = findLatestUserModelChoice(
      messages,
      (messageId) => getSyncParts(messageId, directory),
    )
    if (!choice) {
      return null
    }
    return {
      agent: choice.agent,
      providerID: choice.providerID,
      modelID: choice.modelID,
      variant: choice.variant,
    }
  },

  getCurrentAgent: (sessionId) => {
    return useSelectionStore.getState().sessionAgentSelections.get(sessionId) ?? undefined
  },

  debugSessionMessages: async (sessionId) => {
    const msgs = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const session = sessions.find((s) => s.id === sessionId)
    console.log(`Debug session ${sessionId}:`, {
      session,
      messageCount: msgs.length,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        tokens: m.role === "assistant" ? m.tokens : undefined,
      })),
    })
  },

  pollForTokenUpdates: () => {
    // Handled by sync system's SSE stream
  },

  adoptAuthoritativeSessionDirectory: (sessionId) => {
    const target = sessionId ?? get().currentSessionId
    // Only a guess is promoted. A confirmed selection outranks anything sync
    // learns later, and a selection that has since moved on must not be
    // rewritten by a directory that finished bootstrapping in the background.
    if (!target || target !== guessedSelectionSessionId) return
    if (target !== get().currentSessionId) return

    const authoritative = getAuthoritativeSessionDirectory(target)
    if (!authoritative) return

    // The selection stops being a guess even when the directory is unchanged:
    // the value has now been confirmed by the store that owns the session.
    guessedSelectionSessionId = null
    if (authoritative !== get().currentSessionDirectory) {
      set({ currentSessionDirectory: authoritative })
    }
    writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: target, directory: authoritative })
  },

  setSessionDirectory: (sessionId, directory) => {
    const normalized = normalizePath(directory)
    // Callers set this from a confirmed destination (a completed move, a
    // created worktree), so the selection is no longer a guess.
    if (sessionId === guessedSelectionSessionId) {
      guessedSelectionSessionId = null
    }
    if (sessionId === get().currentSessionId) {
      set({ currentSessionDirectory: normalized })
      writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId, directory: normalized })
    }
  },
}))
