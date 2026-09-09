import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';

// Harness: real ChatInput mounted via renderToString (no DOM library in this
// package, so SSR is the mounted convention). ChatInput itself is real;
// leaves that need DOM/Vite or would hide wiring are captured:
// ComposerFooter (canSend/isSending + primary/queue callbacks),
// ComposerEditor (editable/value), toast (info/error), and the worktree
// creation hook (deferred request control). Session/config stores are
// test-controlled hook mocks (SSR server snapshots would otherwise freeze
// to initial state); all other stores/hooks stay real. User actions are
// exercised by invoking the exact callbacks the buttons wire to, and async
// transitions are verified by re-rendering after the awaited settle.
// Store/controller unit tests cover authority transitions; these tests prove
// ChatInput wiring: pending until acceptance, background worktree queue +
// fresh draft + failure toast, and uncertain-transport gates.

let capturedFooter: {
  canSend: boolean;
  isSending: boolean;
  hasContent: boolean;
  disabledReason: string | null;
  onPrimaryAction: () => void;
  onQueueMessage: () => void;
} | null = null;
let capturedEditor: { editable: boolean; value: string } | null = null;

let toastInfos: Array<{ message: unknown }> = [];
let toastErrors: Array<{ message: unknown }> = [];

type MockDraft = {
  open: boolean;
  id: string | null;
  directoryOverride: string | null;
  worktreeIntent: Record<string, unknown> | null;
  branchIntent: Record<string, unknown> | null;
};

let mockSession: {
  currentSessionId: string | null;
  currentSessionDirectory: string | null;
  newSessionDraft: MockDraft;
  sendingNewSessionDraftId: string | null;
} = {
  currentSessionId: null,
  currentSessionDirectory: null,
  newSessionDraft: { open: false, id: null, directoryOverride: null, worktreeIntent: null, branchIntent: null },
  sendingNewSessionDraftId: null,
};
let mockConfig: { currentProviderId: string; currentModelId: string } = {
  currentProviderId: 'p1',
  currentModelId: 'm1',
};

let sendMessageCalls: Array<{ args: Array<unknown> }> = [];
let sendMessageImpl: (...args: Array<unknown>) => Promise<unknown> = async () => undefined;
let openDraftCalls = 0;
let freshDraftCounter = 0;

let worktreeRequestCalls: Array<unknown> = [];
let worktreeRequestImpl: (params: unknown) => Promise<unknown> = async () => null;
let mockWorktreeState: unknown = null;
let mockWorktreeReceipt: unknown = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => ({ src: null, onError: () => undefined, hasLogo: false }),
  preloadProviderLogos: () => undefined,
}));
mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: { colors: { surface: { subtle: '#fff' } } } }),
  useOptionalThemeSystem: () => null,
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ git: null }),
}));
mock.module('@/components/ui', () => ({
  toast: {
    info: (message: unknown) => {
      toastInfos.push({ message });
    },
    error: (message: unknown) => {
      toastErrors.push({ message });
    },
    success: () => undefined,
    warning: () => undefined,
  },
}));
mock.module('@/components/chat/composer/ui/ComposerFooter', () => ({
  ComposerFooter: (props: {
    canSend: boolean;
    isSending: boolean;
    hasContent: boolean;
    disabledReason?: string | null;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    children?: React.ReactNode;
  }) => {
    capturedFooter = {
      canSend: props.canSend,
      isSending: Boolean(props.isSending),
      hasContent: Boolean(props.hasContent),
      disabledReason: (props.disabledReason ?? null) as string | null,
      onPrimaryAction: props.onPrimaryAction,
      onQueueMessage: props.onQueueMessage,
    };
    return React.createElement(
      'div',
      {
        'data-testid': 'mock-footer',
        'data-can-send': String(props.canSend),
        'data-is-sending': String(Boolean(props.isSending)),
      },
      props.children,
    );
  },
}));
mock.module('@/components/chat/composer/editor/ComposerEditor', () => ({
  ComposerEditor: React.forwardRef((_props: { editable?: boolean; value?: string }, _ref: unknown) => {
    void _ref;
    capturedEditor = { editable: Boolean(_props.editable), value: String(_props.value ?? '') };
    return React.createElement('div', {
      'data-testid': 'mock-editor',
      'data-editable': String(Boolean(_props.editable)),
    });
  }),
}));
mock.module('@/components/chat/composer/state/useDraftWorktreeCreation', () => ({
  useDraftWorktreeCreation: () => ({
    state: mockWorktreeState,
    request: (params: unknown) => {
      worktreeRequestCalls.push(params);
      return worktreeRequestImpl(params);
    },
    getReceipt: () => mockWorktreeReceipt,
  }),
}));
mock.module('@/sync/session-ui-store', () => {
  const buildState = (): Record<string, unknown> => ({
    currentSessionId: mockSession.currentSessionId,
    currentSessionDirectory: mockSession.currentSessionDirectory,
    newSessionDraft: mockSession.newSessionDraft,
    sendingNewSessionDraftId: mockSession.sendingNewSessionDraftId,
    abortPromptSessionId: null,
    getDirectoryForSession: () => mockSession.currentSessionDirectory,
    openNewSessionDraft: () => {
      openDraftCalls += 1;
      freshDraftCounter += 1;
      mockSession = {
        ...mockSession,
        currentSessionId: null,
        currentSessionDirectory: null,
        newSessionDraft: {
          open: true,
          id: `draft-fresh-${freshDraftCounter}`,
          directoryOverride: '/repo',
          worktreeIntent: null,
          branchIntent: null,
        },
      };
    },
    setSendingNewSessionDraftId: (id: string | null) => {
      mockSession = { ...mockSession, sendingNewSessionDraftId: id };
    },
    clearAbortPrompt: () => undefined,
    acknowledgeSessionAbort: () => undefined,
  });
  const hook = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown): unknown => selector(buildState()),
    {
      getState: (): Record<string, unknown> => ({
        ...buildState(),
        sendMessage: (...args: Array<unknown>) => {
          sendMessageCalls.push({ args });
          return sendMessageImpl(...args);
        },
      }),
    },
  );
  return {
    useSessionUIStore: hook,
    routeMessage: async () => {
      throw new Error('routeMessage is stubbed in this suite');
    },
    getRememberedSessionDirectory: () => ({ runtime: null, persisted: null }),
    draftBranchCheckoutReceiptMatches: () => false,
    materializeOpenDraftSession: async () => null,
  };
});
mock.module('@/stores/useConfigStore', () => {
  const hook = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown): unknown =>
      selector({
        currentProviderId: mockConfig.currentProviderId,
        currentModelId: mockConfig.currentModelId,
        getModelMetadata: () => undefined,
        modelsMetadata: new Map(),
        providers: [],
        currentVariant: undefined,
        currentAgentName: undefined,
        setAgent: () => undefined,
        getVisibleAgents: () => [],
      }),
    {
      getState: (): Record<string, unknown> => ({
        currentProviderId: mockConfig.currentProviderId,
        currentModelId: mockConfig.currentModelId,
        getModelMetadata: () => undefined,
      }),
    },
  );
  return { useConfigStore: hook };
});

const { ChatInput } = await import('@/components/chat/ChatInput');
const { createChatDraftIdentity, writeChatDraft } = await import('@/lib/chatDraftPersistence');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { setMobileConnectionUncertain } = await import('@/apps/mobile/mobileRecoveryStatus');
const directoryStoreModule = await import('@/stores/useDirectoryStore');
const messageQueueModule = await import('@/stores/messageQueueStore');

const renderChatInput = (): string => renderToString(React.createElement(ChatInput as React.ComponentType));

const seedDraft = (sessionId: string | null, directory: string, text: string): void => {
  const identity = createChatDraftIdentity(getRuntimeKey(), directory, sessionId);
  if (!identity) throw new Error('could not build draft identity for seeded message');
  writeChatDraft(identity, text, []);
};

const resetHarness = (): void => {
  capturedFooter = null;
  capturedEditor = null;
  toastInfos = [];
  toastErrors = [];
  sendMessageCalls = [];
  sendMessageImpl = async () => undefined;
  openDraftCalls = 0;
  worktreeRequestCalls = [];
  worktreeRequestImpl = async () => null;
  mockWorktreeState = null;
  mockWorktreeReceipt = null;
  mockConfig = { currentProviderId: 'p1', currentModelId: 'm1' };
  setMobileConnectionUncertain(false);
  try {
    (directoryStoreModule.useDirectoryStore.setState as (patch: Record<string, unknown>) => void)({
      currentDirectory: '/repo',
    });
  } catch {
    // Real directory store keeps its initial snapshot; identity still resolves
    // through the mocked session directory for these suites.
  }
  try {
    (messageQueueModule.useMessageQueueStore.setState as (patch: Record<string, unknown>) => void)({
      queuedMessages: {},
      sendingIds: {},
    });
  } catch {
    // Empty queue is already the initial snapshot.
  }
};

beforeEach(() => {
  resetHarness();
  mockSession = {
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: { open: false, id: null, directoryOverride: null, worktreeIntent: null, branchIntent: null },
    sendingNewSessionDraftId: null,
  };
  freshDraftCounter = 0;
});

describe('ChatInput sending lifecycle (mounted)', () => {
  test('new-session pending stays active until the send settles', async () => {
    mockSession = {
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: true,
        id: 'draft-pending-1',
        directoryOverride: '/repo',
        worktreeIntent: null,
        branchIntent: null,
      },
      sendingNewSessionDraftId: null,
    };
    seedDraft(null, '/repo', 'hello pending lifecycle');
    const gate = deferred<unknown>();
    sendMessageImpl = () => gate.promise;

    renderChatInput();
    expect(capturedFooter).not.toBeNull();
    expect(capturedFooter?.hasContent).toBe(true);
    expect(capturedFooter?.canSend).toBe(true);
    expect(capturedFooter?.isSending).toBe(false);
    expect(sendMessageCalls).toHaveLength(0);

    capturedFooter?.onPrimaryAction();
    // Synchronous anti-spam lock happens before the first await.
    expect(mockSession.sendingNewSessionDraftId).toBe('draft-pending-1');

    // Let the 50ms paint yield plus pre-send work run; the deferred send is
    // still pending, so the composer must still report sending.
    await sleep(120);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]?.args[0]).toBe('hello pending lifecycle');
    expect(mockSession.sendingNewSessionDraftId).toBe('draft-pending-1');
    renderChatInput();
    expect(capturedFooter?.isSending).toBe(true);

    // Acceptance settles the lifecycle: the lock clears and the draft clears
    // only because the composer still shows exactly what was sent.
    gate.resolve(undefined);
    await sleep(40);
    expect(mockSession.sendingNewSessionDraftId).toBeNull();
    renderChatInput();
    expect(capturedFooter?.isSending).toBe(false);
  });

  test('worktree send queues in the background with a toast and a fresh draft', async () => {
    const intent = {
      runtimeKey: getRuntimeKey(),
      projectRoot: '/repo',
      sourceDirectory: '/repo',
      startRef: 'main',
    };
    mockSession = {
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: true,
        id: 'draft-worktree-1',
        directoryOverride: '/repo',
        worktreeIntent: intent,
        branchIntent: null,
      },
      sendingNewSessionDraftId: null,
    };
    seedDraft(null, '/repo', 'worktree background hello');
    const requestGate = deferred<unknown>();
    worktreeRequestImpl = () => requestGate.promise;
    sendMessageImpl = async () => undefined;

    renderChatInput();
    expect(capturedFooter?.canSend).toBe(true);
    capturedFooter?.onPrimaryAction();
    await sleep(120);

    // Background queue happens before the creation request settles: one
    // request, queued toast, and a fresh draft that keeps the composer
    // interactive while the worktree builds.
    expect(worktreeRequestCalls).toHaveLength(1);
    expect(toastInfos.map((entry) => String(entry.message))).toContain('Worktree queued');
    expect(openDraftCalls).toBe(1);
    expect(mockSession.newSessionDraft.id).not.toBe('draft-worktree-1');
    expect(mockSession.newSessionDraft.open).toBe(true);
    expect(sendMessageCalls).toHaveLength(0);

    // A successful receipt continues to the captured send instead of
    // stranding the prompt in the fresh draft.
    mockWorktreeReceipt = {
      runtimeKey: getRuntimeKey(),
      projectRoot: '/repo',
      sourceDirectory: '/repo',
      startRef: 'main',
      path: '/repo-worktree-1',
    };
    requestGate.resolve(mockWorktreeReceipt);
    await sleep(80);
    expect(sendMessageCalls).toHaveLength(1);
  });

  test('background worktree failure toasts when the draft is no longer current', async () => {
    const intent = {
      runtimeKey: getRuntimeKey(),
      projectRoot: '/repo',
      sourceDirectory: '/repo',
      startRef: 'main',
    };
    mockSession = {
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: true,
        id: 'draft-worktree-fail-1',
        directoryOverride: '/repo',
        worktreeIntent: intent,
        branchIntent: null,
      },
      sendingNewSessionDraftId: null,
    };
    seedDraft(null, '/repo', 'worktree fail hello');
    const requestGate = deferred<unknown>();
    worktreeRequestImpl = () => requestGate.promise;
    sendMessageImpl = async () => {
      throw new Error('failure path must not reach send');
    };

    renderChatInput();
    capturedFooter?.onPrimaryAction();
    await sleep(120);
    expect(worktreeRequestCalls).toHaveLength(1);
    expect(openDraftCalls).toBe(1);
    // The fresh draft replaced the submitted one, so the failure is no
    // longer current and must surface instead of silently restoring.
    expect(mockSession.newSessionDraft.id).not.toBe('draft-worktree-fail-1');

    requestGate.resolve(null);
    await sleep(80);
    expect(toastErrors.map((entry) => String(entry.message))).toContain('Worktree creation failed');
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('uncertain mobile transport blocks submit, queue, and send affordance while the draft stays editable', async () => {
    mockSession = {
      currentSessionId: 's-mobile-1',
      currentSessionDirectory: '/repo',
      newSessionDraft: { open: false, id: null, directoryOverride: null, worktreeIntent: null, branchIntent: null },
      sendingNewSessionDraftId: null,
    };
    seedDraft('s-mobile-1', '/repo', 'keep my draft while uncertain');
    sendMessageImpl = async () => undefined;

    renderChatInput();
    expect(capturedFooter?.canSend).toBe(true);
    expect(capturedEditor?.editable).toBe(true);
    expect(capturedEditor?.value).toBe('keep my draft while uncertain');

    setMobileConnectionUncertain(true);
    renderChatInput();
    expect(capturedFooter?.canSend).toBe(false);
    expect(capturedFooter?.disabledReason).toBe('Connection lost. Waiting to reconnect — your draft is kept.');
    // Typing stays enabled so the draft remains local.
    expect(capturedEditor?.editable).toBe(true);
    expect(capturedEditor?.value).toBe('keep my draft while uncertain');

    // Imperative submit gate: no send, draft kept, explicit toast.
    capturedFooter?.onPrimaryAction();
    await sleep(20);
    expect(sendMessageCalls).toHaveLength(0);
    expect(toastErrors.map((entry) => String(entry.message))).toContain(
      'Connection lost. Waiting to reconnect — your draft is kept.',
    );

    // Queue gate: nothing enqueues while uncertain.
    const queueBefore = JSON.stringify(
      (messageQueueModule.useMessageQueueStore.getState() as { queuedMessages: unknown }).queuedMessages,
    );
    capturedFooter?.onQueueMessage();
    await sleep(20);
    const queueAfter = JSON.stringify(
      (messageQueueModule.useMessageQueueStore.getState() as { queuedMessages: unknown }).queuedMessages,
    );
    expect(queueAfter).toBe(queueBefore);
    expect(toastErrors).toHaveLength(2);

    // Recovery re-enables sending without losing the draft.
    setMobileConnectionUncertain(false);
    renderChatInput();
    expect(capturedFooter?.canSend).toBe(true);
    expect(capturedEditor?.editable).toBe(true);
    expect(capturedEditor?.value).toBe('keep my draft while uncertain');
  });
});
