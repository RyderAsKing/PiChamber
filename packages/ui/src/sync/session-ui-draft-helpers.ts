import type { Session } from '@/lib/chat/types';
import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { getAllSyncSessions, getSyncSessionDirectory } from './sync-refs';
import {
  resolveSessionDirectoryFromSources,
  type SessionDirectorySources,
} from './session-directory-resolution';
import { readLastActiveSession } from './last-session-cache';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { deriveSessionTitle } from '@/lib/chat/deriveSessionTitle';
import { isPiThinkingLevel } from '@/lib/pi/thinking';
import { useSelectionStore } from './selection-store';
import {
  type DraftBranchCheckoutReceipt,
  type DraftBranchIntent,
  type DraftWorktreeCreationReceipt,
  type NewSessionDraftState,
  type SyntheticContextPart,
} from './session-ui-types';

export const DEFAULT_DRAFT: NewSessionDraftState = {
  id: null,
  open: false,
  directoryOverride: null,
  branchIntent: null,
  worktreeIntent: null,
  parentID: null,
};

export const isNewSessionDraftSendPending = (
  draft: NewSessionDraftState,
  currentSessionId: string | null,
  sendingDraftId: string | null,
): boolean => Boolean(
  draft.open
  && draft.id
  && draft.id === sendingDraftId
  && currentSessionId === null,
);

export const resolveDirectoryKey = (session: Session): string | null => {
  const sessionRecord = session as Session & {
    directory?: string | null;
  };
  return normalizePath(sessionRecord.directory ?? null);
};

const safeStorage = getDeferredSafeStorage();
const DRAFT_TARGET_STORAGE_KEY = 'oc.chatInput.lastDraftTarget';

export type PersistedDraftTarget = {
  projectId: string | null;
  directory: string | null;
};

export const readPersistedDraftTarget = (): PersistedDraftTarget | null => {
  try {
    const raw = safeStorage.getItem(DRAFT_TARGET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      projectId?: unknown;
      directory?: unknown;
    };
    return {
      projectId:
        typeof parsed?.projectId === 'string' ? parsed.projectId : null,
      directory: normalizePath(
        typeof parsed?.directory === 'string' ? parsed.directory : null
      ),
    };
  } catch {
    return null;
  }
};

export const persistDraftTarget = (target: PersistedDraftTarget): void => {
  try {
    safeStorage.setItem(DRAFT_TARGET_STORAGE_KEY, JSON.stringify(target));
  } catch {
    /* ignored */
  }
};

export const getAuthoritativeSessionDirectory = (
  sessionId: string
): string | null => {
  const target = getAllSyncSessions().find((s) => s.id === sessionId);
  const recordDirectory = target ? resolveDirectoryKey(target) : null;
  if (recordDirectory) return normalizePath(recordDirectory);
  const owningDirectory = getSyncSessionDirectory(sessionId);
  return owningDirectory ? normalizePath(owningDirectory) : null;
};

export type RuntimeSessionMemory = {
  sessionId: string | null;
  directory: string | null;
  draft: NewSessionDraftState;
};

export const runtimeSessionMemory = new Map<string, RuntimeSessionMemory>();
export const activeSessionByRuntime = new Map<string, string | null>();

export const runtimeMemoryKey = (value?: string | null): string => {
  const key = (value ?? getRuntimeKey()).trim();
  return key || 'default';
};

export const cloneDraft = (
  draft: NewSessionDraftState
): NewSessionDraftState => ({ ...draft });

export const writeRuntimeSessionMemory = (
  key: string,
  patch: Partial<RuntimeSessionMemory>
): void => {
  const current = runtimeSessionMemory.get(key);
  runtimeSessionMemory.set(key, {
    sessionId: current?.sessionId ?? null,
    directory: current?.directory ?? null,
    draft: current?.draft ? cloneDraft(current.draft) : { ...DEFAULT_DRAFT },
    ...patch,
  });
};

export const getRememberedSessionDirectory = (
  sessionId: string
): {
  runtime: string | null;
  persisted: string | null;
} => {
  const key = runtimeMemoryKey();
  const runtimeMemory = runtimeSessionMemory.get(key);
  const persisted = readLastActiveSession(key);
  return {
    runtime:
      runtimeMemory?.sessionId === sessionId
        ? normalizePath(runtimeMemory.directory)
        : null,
    persisted:
      persisted?.sessionId === sessionId
        ? normalizePath(persisted.directory)
        : null,
  };
};

let guessedSelectionSessionId: string | null = null;

export const getGuessedSelectionSessionId = (): string | null => guessedSelectionSessionId;

export const setGuessedSelectionSessionId = (id: string | null) => {
  guessedSelectionSessionId = id;
};

export const clearGuessedSelectionSessionId = () => {
  guessedSelectionSessionId = null;
};

export const collectSessionDirectorySources = (
  sessionId: string,
  selected: string | null
): SessionDirectorySources => ({
  session: getAllSyncSessions().find((s) => s.id === sessionId) ?? null,
  currentDirectory:
    sessionId === guessedSelectionSessionId ? null : normalizePath(selected),
});

export const resolveSessionDirectory = (
  sessionId: string | null | undefined,
  selected: string | null = null
): string | null => {
  if (!sessionId) return null;
  const resolution = resolveSessionDirectoryFromSources(
    collectSessionDirectorySources(sessionId, selected)
  );
  return resolution?.directory ?? null;
};

export const activateConfigForDirectory = async (
  directory: string | null | undefined
): Promise<void> => {
  await useConfigStore.getState().activateDirectory(normalizePath(directory));
};

export const draftBranchCheckoutReceiptMatches = (
  intent: DraftBranchIntent | null | undefined,
  receipt: DraftBranchCheckoutReceipt | null | undefined
): boolean => {
  if (!intent || !receipt) return false;
  return (
    intent.runtimeKey === receipt.runtimeKey &&
    normalizePath(intent.directory) === normalizePath(receipt.directory) &&
    intent.branch === receipt.branch
  );
};

export type MaterializedDraftSession = {
  sessionId: string;
  directory: string | null;
  agent?: string;
  syntheticParts?: SyntheticContextPart[];
};

export async function materializeOpenDraftSession(
  selection: {
    providerID: string;
    modelID: string;
    agent?: string;
    variant?: string;
    initialPrompt?: string;
    branchCheckoutReceipt?: DraftBranchCheckoutReceipt;
    worktreeCreationReceipt?: DraftWorktreeCreationReceipt;
    draftSnapshot?: NewSessionDraftState;
    initialInputKind?: 'extension-command';
  },
  sessionUIStoreApi: {
    getState: () => {
      newSessionDraft: NewSessionDraftState;
      currentSessionId: string | null;
      createSession: (
        title?: string,
        directoryOverride?: string | null,
        parentID?: string | null,
        metadata?: Record<string, unknown>,
        options?: {
          draftSnapshot?: NewSessionDraftState;
          closeDraft?: boolean;
        }
      ) => Promise<Session | null>;
      initializeNewPiChamberSession: (
        sessionId: string,
        agents: unknown[]
      ) => void;
      setCurrentSession: (id: string | null, directoryHint?: string | null) => void;
    };
  }
): Promise<MaterializedDraftSession | null> {
  const store = sessionUIStoreApi.getState();
  const draft = selection.draftSnapshot ?? store.newSessionDraft;
  if (!draft?.open) return null;
  if (draft.branchIntent) {
    const branchDirectory = normalizePath(draft.branchIntent.directory);
    const draftDirectory = normalizePath(draft.directoryOverride);
    if (
      draft.branchIntent.runtimeKey !== getRuntimeKey() ||
      branchDirectory !== draftDirectory
    ) {
      throw new Error(
        'The selected branch no longer matches this draft target.'
      );
    }
    if (
      !draftBranchCheckoutReceiptMatches(
        draft.branchIntent,
        selection.branchCheckoutReceipt
      )
    ) {
      throw new Error(
        'Confirm the selected branch before creating this session.'
      );
    }
  }
  if (draft.worktreeIntent) {
    const receipt = selection.worktreeCreationReceipt;
    if (
      !receipt ||
      receipt.runtimeKey !== draft.worktreeIntent.runtimeKey ||
      normalizePath(receipt.projectRoot) !==
        normalizePath(draft.worktreeIntent.projectRoot) ||
      normalizePath(receipt.sourceDirectory) !==
        normalizePath(draft.worktreeIntent.sourceDirectory) ||
      receipt.startRef !== draft.worktreeIntent.startRef ||
      !normalizePath(receipt.path)
    ) {
      throw new Error(
        'Create the selected worktree before creating this session.'
      );
    }
  }
  const draftPermissionAutoAcceptEnabled =
    draft.permissionAutoAcceptEnabled === true;

  const trimmedAgent =
    typeof selection.agent === 'string' && selection.agent.trim().length > 0
      ? selection.agent.trim()
      : undefined;
  const draftDirectoryOverride =
    selection.worktreeCreationReceipt?.path ??
    draft.directoryOverride ??
    null;
  const draftProjectId = draft.selectedProjectId ?? null;

  // A slash-prefixed initial input never supplies the client-side title.
  // Extension commands must leave the session unnamed until the first real
  // conversation prompt; prompt templates, skills, and other slash inputs
  // are titled authoritatively by the daemon after dispatch, which resolves
  // the live registered-command catalog. Deriving here would race that
  // catalog and could name an extension-configured session "/balance".
  const derivedTitle =
    draft.title ||
    (selection.initialPrompt && !selection.initialPrompt.trimStart().startsWith('/')
      ? deriveSessionTitle(selection.initialPrompt)
      : undefined);

  const created = await store.createSession(
    derivedTitle,
    draftDirectoryOverride,
    draft.parentID ?? null,
    {
      model:
        selection.providerID && selection.modelID
          ? {
              providerId: selection.providerID,
              modelId: selection.modelID,
            }
          : undefined,
      thinking: isPiThinkingLevel(selection.variant)
        ? selection.variant
        : undefined,
      select: false,
    },
    {
      draftSnapshot: draft,
      closeDraft: false,
    }
  );
  if (!created?.id) throw new Error('Failed to create session');

  const createdDirectory = normalizePath(
    created.directory ?? draftDirectoryOverride ?? null
  );
  const shouldActivateCreatedSession =
    sessionUIStoreApi.getState().newSessionDraft === draft &&
    sessionUIStoreApi.getState().currentSessionId === null;

  if (shouldActivateCreatedSession) {
    persistDraftTarget({
      projectId: draftProjectId,
      directory: createdDirectory,
    });
  }

  const draftSyntheticParts = draft.syntheticParts;
  const configState = useConfigStore.getState();
  if (shouldActivateCreatedSession) {
    void activateConfigForDirectory(createdDirectory).catch((error) => {
      console.warn(
        'Failed to activate directory after creating session:',
        error
      );
    });
  }

  const effectiveDraftAgent = trimmedAgent ?? configState.currentAgentName;

  useSelectionStore
    .getState()
    .saveSessionModelSelection(
      created.id,
      selection.providerID,
      selection.modelID
    );

  if (effectiveDraftAgent) {
    useSelectionStore
      .getState()
      .saveSessionAgentSelection(created.id, effectiveDraftAgent);
    useSelectionStore
      .getState()
      .saveAgentModelForSession(
        created.id,
        effectiveDraftAgent,
        selection.providerID,
        selection.modelID
      );
    useSelectionStore
      .getState()
      .saveAgentModelVariantForSession(
        created.id,
        effectiveDraftAgent,
        selection.providerID,
        selection.modelID,
        selection.variant
      );
  }

  store.initializeNewPiChamberSession(created.id, configState.agents ?? []);

  if (shouldActivateCreatedSession) {
    store.setCurrentSession(created.id, createdDirectory);
  }

  if (draftPermissionAutoAcceptEnabled) {
    void import('@/stores/permissionStore')
      .then(({ usePermissionStore }) =>
        usePermissionStore.getState().setSessionAutoAccept(created.id, true)
      )
      .catch((error) => {
        console.warn(
          'Failed to apply draft permission auto-accept to new session:',
          error
        );
      });
  }

  return {
    sessionId: created.id,
    directory: createdDirectory,
    agent: effectiveDraftAgent,
    syntheticParts: draftSyntheticParts,
  };
}
