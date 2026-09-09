import { describe, expect, test, beforeEach } from 'bun:test';
import { getQueuedAutoSendBlockedReason, queuedSendOperationId, rehydrateSendIntentFromQueueEntry } from '@/hooks/useQueuedMessageAutoSend';
import {
  createMessageQueueTarget,
  getPersistedMessageQueueStateForTests,
  sanitizeQueuedAttachmentForPersist,
  useMessageQueueStore,
} from '@/stores/messageQueueStore';
import { deriveStableMessageId, clearSendIntentsForTests, getSendIntent } from '@/lib/pi/send-intent';
import { routeMessage } from '@/sync/session-ui-message-routing';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { createReducerPartMap } from '@/lib/pi/event-reducer';
import { initialCatalog } from '@/sync/pi-session-catalog';

const seedStore = (epoch = 'epoch-1') => {
  const store = getPiSessionStore();
  const internal = store as unknown as {
    state: ReturnType<typeof store.getState>;
    hydratedSessionIds: Set<string>;
    streamEpoch: string | null;
  };
  const sessionId = 's-queue-auth';
  const directory = '/repo';
  internal.hydratedSessionIds = new Set([sessionId]);
  internal.streamEpoch = epoch;
  internal.state = {
    ...store.getState(),
    directory,
    connection: 'ready' as const,
    sessions: [{ session: { id: sessionId, directory, title: sessionId, createdAt: 1, updatedAt: 1 } } as never],
    selectedSessionId: sessionId,
    reducer: {
      bySession: new Map([[sessionId, {
        sessionId, directory, lastSequence: 5_000, lifecycle: 'idle' as const,
        messages: new Map(), partOrder: new Map(), parts: createReducerPartMap(),
        toolsByCallId: new Map(), streamingMessages: new Set(), extensionStatuses: new Map(),
        extensionWidgets: new Map(), extensionDialogs: [], extensionNotices: [], extensionErrors: [],
        extensionPanels: new Map(), extensionApps: new Map(), queue: { steering: 0, followUp: 0 },
      }]]),
      lastSequence: new Map([[sessionId, 5_000]]),
    },
    hydratedSessionIds: new Set([sessionId]),
    catalog: {
      ...initialCatalog(),
      byId: new Map(),
      byDirectory: new Map(),
      listStatusByDirectory: new Map(),
    },
    syncReadiness: 'ready' as const,
    syncRecovery: { directories: [], residents: [] },
    sendStateById: new Map(),
  };
  (store as unknown as { stream: unknown }).stream = { dispose: () => undefined };
  return { store, sessionId, directory };
};

describe('queue authority forwarding and persisted attachments', () => {
  test('queued operation id derives the stable message id used for the actual send', async () => {
    clearSendIntentsForTests();
    const { store, sessionId } = seedStore('epoch-1');
    const originalPrompt = store.prompt.bind(store);
    const prompts: unknown[][] = [];
    (store as unknown as { prompt: unknown }).prompt = (async (...args: unknown[]) => {
      prompts.push(args);
      return { accepted: true, messageId: 'm-1' };
    }) as typeof store.prompt;
    try {
      const queuedId = 'queued-abc123';
      const operationId = queuedSendOperationId(queuedId);
      await routeMessage({
        sessionId, directory: '/repo', content: 'queued hello',
        providerID: 'provider', modelID: 'model', operationId,
      });
      expect(prompts).toHaveLength(1);
      const options = (prompts[0] as unknown[])[4] as { operationId?: string; messageId?: string; streamEpoch?: string };
      expect(options.operationId).toBe(operationId);
      expect(options.messageId).toBe(deriveStableMessageId(operationId));
      expect(options.streamEpoch).toBe('epoch-1');
    } finally {
      (store as unknown as { prompt: unknown }).prompt = originalPrompt;
      clearSendIntentsForTests();
    }
  });

  test('persisted ready uploads keep attachment ids without file bytes or preview URLs', () => {
    const persisted = getPersistedMessageQueueStateForTests({
      queuedMessages: {
        key: [{
          id: 'queued-1',
          content: 'with upload',
          createdAt: 1,
          attachments: [{
            id: 'att-1',
            file: { name: 'a.png' } as unknown as File,
            dataUrl: 'data:image/png;base64,AQID',
            previewUrl: 'blob:http://localhost/preview',
            mimeType: 'image/png',
            filename: 'a.png',
            size: 4,
            source: 'local',
            uploadState: { status: 'ready', attachmentId: 'opaque-1', expiresAt: Date.now() + 60_000 },
          }],
          sendAuthority: {
            operationId: queuedSendOperationId('queued-1'),
            messageId: 'msg_qm:queued-1',
            streamEpoch: 'epoch-1',
            runtimeKey: 'runtime-a',
            capturedAt: 1,
          },
        }],
      },
      quarantinedLegacyMessages: {},
      followUpBehavior: 'queue',
    });
    const attachment = persisted.queuedMessages.key[0]?.attachments?.[0];
    expect(attachment?.uploadState).toEqual({ status: 'ready', attachmentId: 'opaque-1', expiresAt: (attachment?.uploadState as { expiresAt: number }).expiresAt });
    expect((attachment as unknown as { file?: unknown }).file).toBeUndefined();
    expect(attachment?.previewUrl).toBeUndefined();
    expect(attachment?.dataUrl).toBe('');
    expect(persisted.queuedMessages.key[0]?.sendAuthority?.operationId).toBe(queuedSendOperationId('queued-1'));
  });

  test('ready attachment ids are reused without re-upload; unavailable bytes block reexecution', async () => {
    clearSendIntentsForTests();
    const { store, sessionId } = seedStore('epoch-1');
    const originalPrompt = store.prompt.bind(store);
    const originalUpload = store.uploadFile.bind(store);
    const prompts: unknown[][] = [];
    let uploads = 0;
    (store as unknown as { prompt: unknown }).prompt = (async (...args: unknown[]) => {
      prompts.push(args);
      return { accepted: true, messageId: 'm-ready' };
    }) as typeof store.prompt;
    (store as unknown as { uploadFile: unknown }).uploadFile = (async () => {
      uploads += 1;
      throw new Error('ready attachments must not upload again');
    }) as typeof store.uploadFile;
    try {
      await routeMessage({
        sessionId, directory: '/repo', content: 'reuse hello',
        providerID: 'provider', modelID: 'model', operationId: 'op-reuse-ready',
        files: [{
          type: 'file', mime: 'image/png', filename: 'a.png', url: '',
          uploadState: { status: 'ready', attachmentId: 'opaque-reuse', expiresAt: Date.now() + 60_000 },
        }],
      });
      expect(uploads).toBe(0);
      expect((prompts[0] as unknown[])[3]).toEqual([{ id: 'opaque-reuse' }]);

      await expect(routeMessage({
        sessionId, directory: '/repo', content: 'expired hello',
        providerID: 'provider', modelID: 'model', operationId: 'op-expired-blocked',
        files: [{
          type: 'file', mime: 'image/png', filename: 'a.png', url: '',
          uploadState: { status: 'ready', attachmentId: 'opaque-expired', expiresAt: Date.now() - 1_000 },
        }],
      })).rejects.toThrow('Attachment data is unavailable');
    } finally {
      (store as unknown as { prompt: unknown }).prompt = originalPrompt;
      (store as unknown as { uploadFile: unknown }).uploadFile = originalUpload;
      clearSendIntentsForTests();
    }
  });

  test('sanitizer keeps legacy data URLs for refresh but never persists File handles', () => {
    const attachment = sanitizeQueuedAttachmentForPersist({
      id: 'att-legacy',
      file: { name: 'note.txt' } as unknown as File,
      dataUrl: 'data:text/plain;base64,aGVsbG8=',
      mimeType: 'text/plain',
      filename: 'note.txt',
      size: 5,
      source: 'local',
    } as never);
    expect(attachment.dataUrl).toBe('data:text/plain;base64,aGVsbG8=');
    expect((attachment as unknown as { file?: unknown }).file).toBeUndefined();
    expect(attachment.previewUrl).toBeUndefined();
  });

  test('runtime isolation helper keeps targets separate', () => {
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    const a = createMessageQueueTarget('session-1', '/repo', 'runtime-a')!;
    const b = createMessageQueueTarget('session-1', '/repo', 'runtime-b')!;
    useMessageQueueStore.getState().addToQueue(a, { content: 'from A' });
    expect(useMessageQueueStore.getState().getQueueForTarget(a)).toHaveLength(1);
    expect(useMessageQueueStore.getState().getQueueForTarget(b)).toHaveLength(0);
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
  });
});

describe('explicit requeue captures fresh verified authority', () => {
  test('missing authority becomes unblocked current-epoch authority with payload preserved', () => {
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const target = createMessageQueueTarget('s1', '/repo', 'runtime-a')!;
      useMessageQueueStore.getState().addToQueue(target, {
        content: 'blocked hello',
        sendConfig: { providerID: 'provider', modelID: 'model', agent: 'agent', variant: 'variant' },
        attachments: [{
          id: 'att-1',
          dataUrl: 'data:text/plain;base64,aGVsbG8=',
          mimeType: 'text/plain',
          filename: 'note.txt',
          size: 5,
          source: 'local',
        } as never],
      });
      const before = useMessageQueueStore.getState().getQueueForTarget(target);
      expect(before).toHaveLength(1);
      expect(getQueuedAutoSendBlockedReason(before[0]!, target, 'runtime-a', 'epoch-1')).toBe('missing-authority');
      // Explicit duplicate-warning consent with freshly verified authority.
      const freshId = useMessageQueueStore.getState().requeueWithNewIntent(target, before[0]!.id, {
        runtimeKey: 'runtime-a',
        streamEpoch: 'epoch-1',
      });
      expect(typeof freshId).toBe('string');
      expect(warnings.some((line) => line.includes('duplicate') || line.includes('new send intent'))).toBe(true);
      const after = useMessageQueueStore.getState().getQueueForTarget(target);
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(freshId);
      expect(after[0]?.content).toBe('blocked hello');
      expect(after[0]?.sendConfig).toEqual({ providerID: 'provider', modelID: 'model', agent: 'agent', variant: 'variant' });
      expect(after[0]?.attachments?.[0]?.filename).toBe('note.txt');
      const operationId = queuedSendOperationId(freshId!);
      expect(after[0]?.sendAuthority?.operationId).toBe(operationId);
      expect(after[0]?.sendAuthority?.messageId).toBe(deriveStableMessageId(operationId));
      expect(after[0]?.sendAuthority?.runtimeKey).toBe('runtime-a');
      expect(after[0]?.sendAuthority?.streamEpoch).toBe('epoch-1');
      expect(getQueuedAutoSendBlockedReason(after[0]!, target, 'runtime-a', 'epoch-1')).toBeNull();
    } finally {
      console.warn = originalWarn;
      useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    }
  });

  test('stale epochs never carry forward; the fresh entry stamps the verified epoch', () => {
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    try {
      const target = createMessageQueueTarget('s1', '/repo', 'runtime-a')!;
      const staleId = 'queued-stale-1';
      const staleOperationId = queuedSendOperationId(staleId);
      useMessageQueueStore.setState({
        queuedMessages: {
          [`runtime-a\n/repo\ns1`]: [{
            id: staleId,
            content: 'stale hello',
            createdAt: 1,
            sendAuthority: {
              operationId: staleOperationId,
              messageId: deriveStableMessageId(staleOperationId),
              streamEpoch: 'epoch-old',
              runtimeKey: 'runtime-a',
              capturedAt: 1,
            },
          }],
        },
      });
      const before = useMessageQueueStore.getState().getQueueForTarget(target);
      expect(getQueuedAutoSendBlockedReason(before[0]!, target, 'runtime-a', 'epoch-1')).toBe('stale-epoch');
      const freshId = useMessageQueueStore.getState().requeueWithNewIntent(target, staleId, {
        runtimeKey: 'runtime-a',
        streamEpoch: 'epoch-1',
      });
      expect(typeof freshId).toBe('string');
      const after = useMessageQueueStore.getState().getQueueForTarget(target);
      expect(after[0]?.content).toBe('stale hello');
      expect(after[0]?.sendAuthority?.streamEpoch).toBe('epoch-1');
      expect(getQueuedAutoSendBlockedReason(after[0]!, target, 'runtime-a', 'epoch-1')).toBeNull();
    } finally {
      useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    }
  });

  test('requeue is current-runtime only and clears a stale sending flag for the old id', () => {
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    try {
      const target = createMessageQueueTarget('s1', '/repo', 'runtime-a')!;
      const queuedId = useMessageQueueStore.getState().addToQueue(target, { content: 'runtime hello' });
      useMessageQueueStore.getState().markSending(target, queuedId);
      const staleTarget = { ...target, runtimeKey: 'runtime-old' };
      expect(useMessageQueueStore.getState().requeueWithNewIntent(staleTarget, queuedId, {
        runtimeKey: 'runtime-a',
        streamEpoch: 'epoch-1',
      })).toBeNull();
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(1);
      const freshId = useMessageQueueStore.getState().requeueWithNewIntent(target, queuedId, {
        runtimeKey: 'runtime-a',
        streamEpoch: 'epoch-1',
      });
      expect(typeof freshId).toBe('string');
      expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(1);
    } finally {
      useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    }
  });
});

describe('durable send-intent reuse across reload', () => {
  beforeEach(() => {
    clearSendIntentsForTests();
  });

  test('a reloaded pending dispatch reuses durable authority instead of recapturing a fresh epoch', () => {
    const target = createMessageQueueTarget('s1', '/repo', 'runtime-a')!;
    const queuedId = 'queued-durable-1';
    const operationId = queuedSendOperationId(queuedId);
    const queued = {
      id: queuedId,
      content: 'durable hello',
      createdAt: 1,
      sendConfig: { providerID: 'provider', modelID: 'model' },
      attachments: [{
        id: 'att-ready-1',
        dataUrl: '',
        mimeType: 'image/png',
        filename: 'a.png',
        size: 4,
        source: 'local',
        uploadState: { status: 'ready', attachmentId: 'opaque-1', expiresAt: Date.now() + 60_000 },
      }],
      sendAuthority: {
        operationId,
        messageId: deriveStableMessageId(operationId),
        streamEpoch: 'epoch-1',
        runtimeKey: 'runtime-a',
        capturedAt: 1,
      },
    } as never;
    expect(getSendIntent(operationId)).toBeUndefined();
    const rehydrated = rehydrateSendIntentFromQueueEntry(target, queued, 'durable hello', {
      providerID: 'provider',
      modelID: 'model',
    });
    expect(rehydrated).toBe(true);
    const intent = getSendIntent(operationId);
    expect(intent?.messageId).toBe(deriveStableMessageId(operationId));
    expect(intent?.streamEpoch).toBe('epoch-1');
    expect(intent?.attachmentIds).toEqual(['opaque-1']);
    expect(intent?.text).toBe('durable hello');
    clearSendIntentsForTests();
  });

  test('expired uploads are never re-uploaded under the original uncertain id', () => {
    const target = createMessageQueueTarget('s1', '/repo', 'runtime-a')!;
    const queuedId = 'queued-expired-1';
    const operationId = queuedSendOperationId(queuedId);
    const queued = {
      id: queuedId,
      content: 'expired hello',
      createdAt: 1,
      attachments: [{
        id: 'att-expired-1',
        dataUrl: '',
        mimeType: 'image/png',
        filename: 'a.png',
        size: 4,
        source: 'local',
        uploadState: { status: 'ready', attachmentId: 'opaque-expired', expiresAt: Date.now() - 1_000 },
      }],
      sendAuthority: {
        operationId,
        messageId: deriveStableMessageId(operationId),
        streamEpoch: 'epoch-1',
        runtimeKey: 'runtime-a',
        capturedAt: 1,
      },
    } as never;
    expect(rehydrateSendIntentFromQueueEntry(target, queued, 'expired hello', {
      providerID: 'provider',
      modelID: 'model',
    })).toBe(false);
    expect(getSendIntent(operationId)).toBeUndefined();
    clearSendIntentsForTests();
  });
});
