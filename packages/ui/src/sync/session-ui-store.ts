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
import type { SessionContextUsage } from "@/stores/types/sessionTypes"
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
import { useInputStore } from "./input-store"
import { useSelectionStore } from "./selection-store"
import { getViewportSessionMemory, useViewportStore, viewportSessionKey } from "./viewport-store"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { clearLastActiveSession, persistLastActiveSession } from "./last-session-cache"
import {
  type AttachedFile,
  type DraftBranchCheckoutReceipt,
  type DraftBranchIntent,
  type DraftWorktreeIntent,
  type DraftWorktreeCreationReceipt,
  type SendMessageOptions,
  type AssistantMessageSessionExecution,
  type NewSessionDraftState,
  type ViewportAnchor,
  type SessionHistoryMeta,
  type SessionUIState,
} from "./session-ui-types"
import { routeMessage } from "./session-ui-message-routing"
import {
  DEFAULT_DRAFT,
  readPersistedDraftTarget,
  persistDraftTarget,
  getRememberedSessionDirectory,
  resolveSessionDirectory,
  resolveDirectoryKey,
  getAuthoritativeSessionDirectory,
  activateConfigForDirectory,
  draftBranchCheckoutReceiptMatches,
  runtimeMemoryKey,
  cloneDraft,
  writeRuntimeSessionMemory,
  setGuessedSelectionSessionId,
  getGuessedSelectionSessionId,
  clearGuessedSelectionSessionId,
  activeSessionByRuntime,
  runtimeSessionMemory,
  materializeOpenDraftSession as materializeOpenDraftSessionHelper,
  type MaterializedDraftSession,
} from "./session-ui-draft-helpers"

export type {
  AttachedFile,
  DraftBranchCheckoutReceipt,
  DraftBranchIntent,
  DraftWorktreeIntent,
  DraftWorktreeCreationReceipt,
  SendMessageOptions,
  AssistantMessageSessionExecution,
  NewSessionDraftState,
  ViewportAnchor,
  SessionHistoryMeta,
  SessionUIState,
}

export {
  routeMessage,
  getRememberedSessionDirectory,
  draftBranchCheckoutReceiptMatches,
}

let newSessionDraftSequence = 0
const createNewSessionDraftId = (): string => {
  newSessionDraftSequence += 1
  return `draft-${Date.now()}-${newSessionDraftSequence}`
}

export async function materializeOpenDraftSession(selection: {
  providerID: string
  modelID: string
  agent?: string
  variant?: string
  initialPrompt?: string
  branchCheckoutReceipt?: DraftBranchCheckoutReceipt
  worktreeCreationReceipt?: DraftWorktreeCreationReceipt
  draftSnapshot?: NewSessionDraftState
  initialInputKind?: 'extension-command'
}): Promise<MaterializedDraftSession | null> {
  return materializeOpenDraftSessionHelper(selection, useSessionUIStore)
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
  sendingNewSessionDraftId: null,
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
    setGuessedSelectionSessionId(isGuessedDir && id ? id : null)
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
      sendingNewSessionDraftId: null,
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
      id: createNewSessionDraftId(),
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
    // Composer attachments live in per-draft slots now: the identity swap
    // stashes the previous session's files instead of destroying them, so
    // returning restores them and the new draft still starts empty.

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
        id: null,
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

  setSendingNewSessionDraftId: (draftId) => {
    if (get().sendingNewSessionDraftId !== draftId) set({ sendingNewSessionDraftId: draftId })
  },

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
        initialInputKind: options?.initialInputKind,
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
        knownEmptyTranscript: true,
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
    if (!target || target !== getGuessedSelectionSessionId()) return
    if (target !== get().currentSessionId) return

    const authoritative = getAuthoritativeSessionDirectory(target)
    if (!authoritative) return

    // The selection stops being a guess even when the directory is unchanged:
    // the value has now been confirmed by the store that owns the session.
    clearGuessedSelectionSessionId()
    if (authoritative !== get().currentSessionDirectory) {
      set({ currentSessionDirectory: authoritative })
    }
    writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: target, directory: authoritative })
  },

  setSessionDirectory: (sessionId, directory) => {
    const normalized = normalizePath(directory)
    // Callers set this from a confirmed destination (a completed move, a
    // created worktree), so the selection is no longer a guess.
    if (sessionId === getGuessedSelectionSessionId()) {
      clearGuessedSelectionSessionId()
    }
    if (sessionId === get().currentSessionId) {
      set({ currentSessionDirectory: normalized })
      writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId, directory: normalized })
    }
  },
}))
