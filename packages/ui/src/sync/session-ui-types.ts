import type { Session } from '@/lib/chat/types';
import type { AttachedFile, SessionContextUsage } from '@/stores/types/sessionTypes';
import type { SyntheticContextPart } from './input-store';
import type {
  ArchiveSessionsOptions,
  DeleteSessionOptions,
  DeleteSessionsOptions,
  UnarchiveSessionsOptions,
} from './session-actions';

export type { AttachedFile, SyntheticContextPart };

export type CapturedSendTarget = {
  runtimeKey: string;
  sessionId: string;
  directory: string;
};

export type DraftBranchCheckoutReceipt = {
  runtimeKey: string;
  directory: string;
  branch: string;
};

export type DraftBranchIntent = {
  runtimeKey: string;
  directory: string;
  branch: string;
};

export type DraftWorktreeIntent = {
  runtimeKey: string;
  projectRoot: string;
  sourceDirectory: string;
  startRef: string;
};

export type DraftWorktreeCreationReceipt = DraftWorktreeIntent & {
  path: string;
  branch: string;
};

export type SendMessageOptions = {
  target?: CapturedSendTarget;
  sessionId?: string;
  directory?: string;
  delivery?: 'steer';
  branchCheckoutReceipt?: DraftBranchCheckoutReceipt;
  worktreeCreationReceipt?: DraftWorktreeCreationReceipt;
  draftSnapshot?: NewSessionDraftState;
  initialInputKind?: 'extension-command';
};

export type AssistantMessageSessionExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  instructions: string;
};

export type NewSessionDraftState = {
  id: string | null;
  open: boolean;
  selectedProjectId?: string | null;
  directoryOverride: string | null;
  branchIntent?: DraftBranchIntent | null;
  worktreeIntent?: DraftWorktreeIntent | null;
  permissionAutoAcceptEnabled?: boolean;
  preserveDirectoryOverride?: boolean;
  parentID: string | null;
  title?: string;
  initialPrompt?: string;
  syntheticParts?: SyntheticContextPart[];
  targetFolderId?: string;
};

export type ViewportAnchor = {
  sessionId: string;
  value: number;
};

export type SessionHistoryMeta = {
  limit: number;
  hasMore: boolean;
  complete: boolean;
  isLoading: boolean;
  loading?: boolean;
  nextCursor?: string;
};

export type SessionUIState = {
  currentSessionId: string | null;
  currentSessionDirectory: string | null;
  newSessionDraft: NewSessionDraftState;
  abortPromptSessionId: string | null;
  abortPromptExpiresAt: number | null;
  error: string | null;
  webUICreatedSessions: Set<string>;
  sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean }>;
  abortControllers: Map<string, AbortController>;
  isLoading: boolean;
  lastLoadedDirectory: string | null;
  /** The draft whose first send is in flight. Other drafts and existing sessions remain interactive. */
  sendingNewSessionDraftId: string | null;
  setSendingNewSessionDraftId: (draftId: string | null) => void;

  // Non-Git mode: dismissed signature hash per session, hides bar until new turn arrives
  pendingChangesBarDismissed: Map<string, string>;
  dismissPendingChangesBar: (sessionId: string, signature: string | null) => void;

  // Actions — UI state management
  setCurrentSession: (id: string | null, directoryHint?: string | null) => void;
  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => void;
  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => void;
  openNewSessionDraft: (
    options?: Partial<NewSessionDraftState> & { automatic?: boolean }
  ) => void;
  closeNewSessionDraft: () => void;
  setNewSessionDraftTarget: (target: {
    projectId?: string | null;
    selectedProjectId?: string | null;
    directoryOverride?: string | null;
    branchIntent?: DraftBranchIntent | null;
    worktreeIntent?: DraftWorktreeIntent | null;
  }) => void;
  setDraftPreserveDirectoryOverride: (value: boolean) => void;
  setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void;
  acknowledgeSessionAbort: (sessionId: string) => void;
  clearAbortPrompt: () => void;
  armAbortPrompt: (durationMs?: number) => number | null;
  clearError: () => void;
  markSessionAsPiChamberCreated: (sessionId: string) => void;
  isPiChamberCreatedSession: (sessionId: string) => boolean;
  getContextUsage: (
    contextLimit: number,
    outputLimit: number
  ) => SessionContextUsage | null;
  initializeNewPiChamberSession: (sessionId: string, agents: unknown[]) => void;
  overrideNewSessionDraftTarget: (options: Record<string, unknown>) => void;

  // Actions — Pi API operations (read domain data from sync-refs)
  sendMessage: (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{
      text: string;
      attachments?: AttachedFile[];
      synthetic?: boolean;
    }>,
    variant?: string,
    inputMode?: 'normal' | 'shell',
    options?: SendMessageOptions
  ) => Promise<void>;

  createSession: (
    title?: string,
    directoryOverride?: string | null,
    parentID?: string | null,
    metadata?: Record<string, unknown>,
    options?: { draftSnapshot?: NewSessionDraftState; closeDraft?: boolean }
  ) => Promise<Session | null>;
  deleteSession: (id: string, options?: DeleteSessionOptions) => Promise<boolean>;
  deleteSessions: (
    ids: string[],
    options?: DeleteSessionsOptions
  ) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
  archiveSession: (id: string) => Promise<boolean>;
  archiveSessions: (
    ids: string[],
    options?: ArchiveSessionsOptions
  ) => Promise<{ archivedIds: string[]; failedIds: string[] }>;
  unarchiveSession: (id: string) => Promise<boolean>;
  unarchiveSessions: (
    ids: string[],
    options?: UnarchiveSessionsOptions
  ) => Promise<{ restoredIds: string[]; failedIds: string[] }>;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
  shareSession: (sessionId: string) => Promise<Session | null>;
  unshareSession: (sessionId: string) => Promise<Session | null>;
  revertToMessage: (
    sessionId: string,
    messageId: string,
    options?: { skipRedoPush?: boolean }
  ) => Promise<void>;
  restoreToMessage: (sessionId: string, messageId: string) => Promise<void>;
  forkFromMessage: (sessionId: string, messageId: string) => Promise<void>;
  handleSlashUndo: (sessionId: string) => Promise<void>;
  handleSlashRedo: (sessionId: string) => Promise<void>;
  createSessionFromAssistantMessage: (
    sourceMessageId: string,
    execution: AssistantMessageSessionExecution
  ) => Promise<void>;

  // Data access helpers (read from sync)
  getSessionsByDirectory: (directory: string) => Session[];
  getDirectoryForSession: (sessionId: string) => string | null;
  getLastUserChoice: (
    sessionId: string
  ) => {
    agent?: string;
    providerID?: string;
    modelID?: string;
    variant?: string;
  } | null;
  getCurrentAgent: (sessionId: string) => string | undefined;
  debugSessionMessages: (sessionId: string) => Promise<void>;
  pollForTokenUpdates: () => void;
  setSessionDirectory: (sessionId: string, directory: string | null) => void;
  /**
   * Replace a guessed selection directory with the authoritative one once sync
   * has indexed the session. Safe to call at any time: it only ever promotes a
   * guess, never overrides a confirmed selection.
   */
  adoptAuthoritativeSessionDirectory: (sessionId?: string) => void;
};
