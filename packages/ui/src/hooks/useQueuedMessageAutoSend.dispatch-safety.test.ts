import { beforeEach, describe, expect, test } from 'bun:test';
import {
  buildQueuedAutoSendPayload,
  getQueuedAutoSendBlockedReason,
  queuedSendOperationId,
  sendQueuedAutoSendPayload,
} from '@/hooks/useQueuedMessageAutoSend';
import {
  createMessageQueueTarget,
  useMessageQueueStore,
  type MessageQueueTarget,
} from '@/stores/messageQueueStore';
import {
  clearSendIntentsForTests,
  deriveStableMessageId,
  getSendIntent,
} from '@/lib/pi/send-intent';
import { routeMessage } from '@/sync/session-ui-message-routing';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { createReducerPartMap } from '@/lib/pi/event-reducer';
import { initialCatalog } from '@/sync/pi-session-catalog';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { AttachedFile } from '@/stores/types/sessionTypes';

const seedPiStore = (epoch: string | null = 'epoch-1', sessionId = 's-dispatch', directory = '/repo') => {
  const store = getPiSessionStore();
  const internal = store as unknown as {
    state: ReturnType<typeof store.getState>;
    hydratedSessionIds: Set<string>;
    streamEpoch: string | null;
  };
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

const readyAttachment = (id: string, attachmentId: string, expiresInMs = 60_000): AttachedFile => ({
  id,
  file: undefined as unknown as File,
  dataUrl: '',
  mimeType: 'image/png',
  filename: 'a.png',
  size: 4,
  source: 'local',
  uploadState: { status: 'ready', attachmentId, expiresAt: Date.now() + expiresInMs },
} as unknown as AttachedFile);

const dataAttachment = (id: string, text = 'hello'): AttachedFile => ({
  id,
  file: new File([text], 'note.txt', { type: 'text/plain' }),
  dataUrl: `data:text/plain;base64,${Buffer.from(text).toString('base64')}`,
  mimeType: 'text/plain',
  filename: 'note.txt',
  size: text.length,
  source: 'local',
} as unknown as AttachedFile);

const preparingAttachment = (id: string): AttachedFile => ({
  id,
  file: new File(['x'], 'a.txt', { type: 'text/plain' }),
  dataUrl: '',
  mimeType: 'text/plain',
  filename: 'a.txt',
  size: 1,
  source: 'local',
  uploadState: { status: 'preparing' },
} as unknown as AttachedFile);

const failedAttachment = (id: string): AttachedFile => ({
  id,
  file: new File(['x'], 'a.txt', { type: 'text/plain' }),
  dataUrl: '',
  mimeType: 'text/plain',
  filename: 'a.txt',
  size: 1,
  source: 'local',
  uploadState: { status: 'failed', error: 'nope' },
} as unknown as AttachedFile);

const installPromptUploadMocks = () => {
  const { store } = seedPiStore('epoch-1');
  const prompts: unknown[][] = [];
  let uploads = 0;
  const uploadedIds: string[] = [];
  const originalPrompt = store.prompt.bind(store);
  const originalUpload = store.uploadFile.bind(store);
  (store as unknown as { prompt: unknown }).prompt = (async (...args: unknown[]) => {
    prompts.push(args);
    return { accepted: true, messageId: 'm-1' };
  }) as typeof store.prompt;
  (store as unknown as { uploadFile: unknown }).uploadFile = (async (_blob: Blob, input: { filename: string; mime: string }) => {
    uploads += 1;
    const id = `uploaded-${uploads}`;
    uploadedIds.push(id);
    return { id, name: input.filename, mime: input.mime, size: 5, expiresAt: Date.now() + 60_000 };
  }) as typeof store.uploadFile;
  return {
    prompts,
    getUploads: () => uploads,
    uploadedIds,
    restore: () => {
      (store as unknown as { prompt: unknown }).prompt = originalPrompt;
      (store as unknown as { uploadFile: unknown }).uploadFile = originalUpload;
    },
  };
};

const queueKeyOf = (target: MessageQueueTarget) => `${target.runtimeKey}\n${target.directory}\n${target.sessionId}`;

const putQueueEntry = (target: MessageQueueTarget, entry: import('@/stores/messageQueueStore').QueuedMessage) => {
  useMessageQueueStore.setState({
    queuedMessages: { [queueKeyOf(target)]: [entry] },
    quarantinedLegacyMessages: {},
    sendingIds: {},
  });
};

beforeEach(() => {
  clearSendIntentsForTests();
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
  seedPiStore('epoch-1');
});

describe('queued dispatch safety through sendMessage → routeMessage → prompt', () => {
  test('fresh data attachments upload once through the normal route and prompt with resolved ids', async () => {
    const runtime = getRuntimeKey();
    const { sessionId, directory } = seedPiStore('epoch-1');
    const target = createMessageQueueTarget(sessionId, directory, runtime)!;
    const mocks = installPromptUploadMocks();
    try {
      const queuedId = 'queued-fresh-data-1';
      const operationId = queuedSendOperationId(queuedId);
      const data = dataAttachment('att-data-1', 'fresh hello');
      putQueueEntry(target, {
        id: queuedId,
        content: 'fresh hello',
        createdAt: 1,
        attachments: [data],
        sendConfig: { providerID: 'provider', modelID: 'model' },
        sendAuthority: {
          operationId,
          messageId: deriveStableMessageId(operationId),
          streamEpoch: 'epoch-1',
          runtimeKey: runtime,
          capturedAt: 1,
          sessionId: target.sessionId,
          text: 'fresh hello',
          sendConfig: { providerID: 'provider', modelID: 'model' },
          dispatched: false,
        },
      } as never);
      const payload = {
        queuedMessageId: queuedId,
        primaryText: 'fresh hello',
        primaryAttachments: [data],
        agentMentionName: undefined,
        sendConfig: { providerID: 'provider', modelID: 'model' },
      } as never;
      await sendQueuedAutoSendPayload(target, payload, { providerID: 'provider', modelID: 'model' });
      expect(mocks.getUploads()).toBe(1);
      expect(mocks.prompts).toHaveLength(1);
      const promptArgs = mocks.prompts[0] as unknown[];
      expect(promptArgs[0]).toBe(sessionId);
      expect(promptArgs[1]).toBe('fresh hello');
      expect(promptArgs[3]).toEqual([{ id: mocks.uploadedIds[0] }]);
      const options = promptArgs[4] as { operationId?: string; messageId?: string; streamEpoch?: string };
      expect(options.operationId).toBe(operationId);
      expect(options.messageId).toBe(deriveStableMessageId(operationId));
      expect(options.streamEpoch).toBe('epoch-1');
      const intent = getSendIntent(operationId);
      expect(intent?.attachmentIds).toEqual([mocks.uploadedIds[0]]);
    } finally {
      mocks.restore();
      clearSendIntentsForTests();
      useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    }
  });

  test('fresh preparing and failed attachments never send text-only: zero uploads and zero prompts', async () => {
    const runtime = getRuntimeKey();
    const { sessionId, directory } = seedPiStore('epoch-1');
    const target = createMessageQueueTarget(sessionId, directory, runtime)!;
    for (const kind of ['preparing', 'failed'] as const) {
      const mocks = installPromptUploadMocks();
      try {
        clearSendIntentsForTests();
        const queuedId = `queued-fresh-${kind}-1`;
        const operationId = queuedSendOperationId(queuedId);
        const attachment = kind === 'preparing' ? preparingAttachment('att-prep') : failedAttachment('att-fail');
        putQueueEntry(target, {
          id: queuedId,
          content: 'blocked hello',
          createdAt: 1,
          attachments: [attachment],
          sendConfig: { providerID: 'provider', modelID: 'model' },
          sendAuthority: {
            operationId,
            messageId: deriveStableMessageId(operationId),
            streamEpoch: 'epoch-1',
            runtimeKey: runtime,
            capturedAt: 1,
            sessionId: target.sessionId,
            text: 'blocked hello',
            sendConfig: { providerID: 'provider', modelID: 'model' },
            dispatched: false,
          },
        } as never);
        const payload = {
          queuedMessageId: queuedId,
          primaryText: 'blocked hello',
          primaryAttachments: [attachment],
          agentMentionName: undefined,
          sendConfig: { providerID: 'provider', modelID: 'model' },
        } as never;
        await expect(sendQueuedAutoSendPayload(target, payload, { providerID: 'provider', modelID: 'model' })).rejects.toThrow();
        expect(mocks.getUploads()).toBe(0);
        expect(mocks.prompts).toHaveLength(0);
        expect(getSendIntent(operationId)).toBeUndefined();
      } finally {
        mocks.restore();
      }
    }
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
  });

  test('expired previously-dispatched entry never re-uploads under the uncertain id', async () => {
    const runtime = getRuntimeKey();
    const { sessionId, directory } = seedPiStore('epoch-1');
    const target = createMessageQueueTarget(sessionId, directory, runtime)!;
    const mocks = installPromptUploadMocks();
    try {
      const queuedId = 'queued-expired-dispatched-1';
      const operationId = queuedSendOperationId(queuedId);
      const expired = readyAttachment('att-exp', 'opaque-expired', -1_000);
      putQueueEntry(target, {
        id: queuedId,
        content: 'expired hello',
        createdAt: 1,
        attachments: [expired],
        sendConfig: { providerID: 'provider', modelID: 'model' },
        sendAuthority: {
          operationId,
          messageId: deriveStableMessageId(operationId),
          streamEpoch: 'epoch-1',
          runtimeKey: runtime,
          capturedAt: 1,
          sessionId: target.sessionId,
          text: 'expired hello',
          sendConfig: { providerID: 'provider', modelID: 'model' },
          attachmentIds: ['opaque-expired'],
          dispatched: true,
        },
      } as never);
      const payload = {
        queuedMessageId: queuedId,
        primaryText: 'expired hello',
        primaryAttachments: [expired],
        agentMentionName: undefined,
        sendConfig: { providerID: 'provider', modelID: 'model' },
      } as never;
      const error = await sendQueuedAutoSendPayload(target, payload, { providerID: 'provider', modelID: 'model' }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).not.toBeNull();
      expect((error as { code?: string }).code).toBe('OPERATION_EXPIRED');
      expect(mocks.getUploads()).toBe(0);
      expect(mocks.prompts).toHaveLength(0);
      expect(getSendIntent(operationId)).toBeUndefined();
    } finally {
      mocks.restore();
      clearSendIntentsForTests();
      useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    }
  });

  test('reload with exact ready manifest reuses epoch/message/config/attachment ids without re-upload', async () => {
    const runtime = getRuntimeKey();
    const { sessionId, directory } = seedPiStore('epoch-1');
    const target = createMessageQueueTarget(sessionId, directory, runtime)!;
    const mocks = installPromptUploadMocks();
    // Never upload in this path: any upload is a regression.
    (getPiSessionStore() as unknown as { uploadFile: unknown }).uploadFile = (async () => {
      throw new Error('reload must not re-upload');
    }) as never;
    try {
      const queuedId = 'queued-reload-ready-1';
      const operationId = queuedSendOperationId(queuedId);
      const ready = readyAttachment('att-ready-1', 'opaque-1');
      putQueueEntry(target, {
        id: queuedId,
        content: 'durable hello',
        createdAt: 1,
        attachments: [{ ...ready, dataUrl: '', file: undefined as unknown as File }],
        sendConfig: { providerID: 'provider', modelID: 'model' },
        sendAuthority: {
          operationId,
          messageId: deriveStableMessageId(operationId),
          streamEpoch: 'epoch-1',
          runtimeKey: runtime,
          capturedAt: 1,
          sessionId: target.sessionId,
          text: 'durable hello',
          sendConfig: { providerID: 'provider', modelID: 'model' },
          attachmentIds: ['opaque-1'],
          dispatched: true,
        },
      } as never);
      clearSendIntentsForTests();
      const payload = {
        queuedMessageId: queuedId,
        primaryText: 'durable hello',
        primaryAttachments: [{ ...ready, dataUrl: '', file: undefined as unknown as File }],
        agentMentionName: undefined,
        sendConfig: { providerID: 'provider', modelID: 'model' },
      } as never;
      await sendQueuedAutoSendPayload(target, payload, { providerID: 'provider', modelID: 'model' });
      expect(mocks.prompts).toHaveLength(1);
      const promptArgs = mocks.prompts[0] as unknown[];
      expect(promptArgs[3]).toEqual([{ id: 'opaque-1' }]);
      const options = promptArgs[4] as { operationId?: string; messageId?: string; streamEpoch?: string; model?: unknown };
      expect(options.operationId).toBe(operationId);
      expect(options.messageId).toBe(deriveStableMessageId(operationId));
      expect(options.streamEpoch).toBe('epoch-1');
      expect(options.model).toEqual({ providerId: 'provider', modelId: 'model' });
    } finally {
      mocks.restore();
      clearSendIntentsForTests();
      useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    }
  });

  test('reload with unknown manifest blocks without upload or prompt', async () => {
    const runtime = getRuntimeKey();
    const { sessionId, directory } = seedPiStore('epoch-1');
    const target = createMessageQueueTarget(sessionId, directory, runtime)!;
    const mocks = installPromptUploadMocks();
    try {
      const queuedId = 'queued-reload-unknown-1';
      const operationId = queuedSendOperationId(queuedId);
      const unknown = {
        id: 'att-unknown-1',
        file: undefined as unknown as File,
        dataUrl: '',
        mimeType: 'text/plain',
        filename: 'a.txt',
        size: 1,
        source: 'local',
      } as AttachedFile;
      putQueueEntry(target, {
        id: queuedId,
        content: 'unknown hello',
        createdAt: 1,
        attachments: [unknown],
        sendConfig: { providerID: 'provider', modelID: 'model' },
        sendAuthority: {
          operationId,
          messageId: deriveStableMessageId(operationId),
          streamEpoch: 'epoch-1',
          runtimeKey: runtime,
          capturedAt: 1,
          sessionId: target.sessionId,
          text: 'unknown hello',
          sendConfig: { providerID: 'provider', modelID: 'model' },
          dispatched: true,
        },
      } as never);
      clearSendIntentsForTests();
      const payload = {
        queuedMessageId: queuedId,
        primaryText: 'unknown hello',
        primaryAttachments: [unknown],
        agentMentionName: undefined,
        sendConfig: { providerID: 'provider', modelID: 'model' },
      } as never;
      await expect(sendQueuedAutoSendPayload(target, payload, { providerID: 'provider', modelID: 'model' })).rejects.toThrow();
      expect(mocks.getUploads()).toBe(0);
      expect(mocks.prompts).toHaveLength(0);
      expect(getSendIntent(operationId)).toBeUndefined();
    } finally {
      mocks.restore();
      clearSendIntentsForTests();
      useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    }
  });

  test('missing epoch blocks the gate and the actual dispatch (zero uploads/prompts)', async () => {
    const runtime = getRuntimeKey();
    const { sessionId, directory } = seedPiStore('epoch-1');
    const target = createMessageQueueTarget(sessionId, directory, runtime)!;
    const queuedId = 'queued-missing-epoch-1';
    const operationId = queuedSendOperationId(queuedId);
    const withoutEpoch = {
      id: queuedId,
      content: 'no epoch hello',
      createdAt: 1,
      sendAuthority: {
        operationId,
        messageId: deriveStableMessageId(operationId),
        runtimeKey: runtime,
        capturedAt: 1,
      },
    } as unknown as import('@/stores/messageQueueStore').QueuedMessage;
    expect(getQueuedAutoSendBlockedReason(withoutEpoch, target, runtime, 'epoch-1')).toBe('missing-epoch');
    expect(getQueuedAutoSendBlockedReason(
      { ...withoutEpoch, sendAuthority: { ...withoutEpoch.sendAuthority!, streamEpoch: 'epoch-1' } } as unknown as import('@/stores/messageQueueStore').QueuedMessage,
      target,
      runtime,
      null,
    )).toBe('missing-epoch');
    const mocks = installPromptUploadMocks();
    try {
      putQueueEntry(target, withoutEpoch);
      const payload = {
        queuedMessageId: queuedId,
        primaryText: 'no epoch hello',
        primaryAttachments: [],
        agentMentionName: undefined,
        sendConfig: { providerID: 'provider', modelID: 'model' },
      } as never;
      await expect(sendQueuedAutoSendPayload(target, payload, { providerID: 'provider', modelID: 'model' })).rejects.toThrow();
      expect(mocks.getUploads()).toBe(0);
      expect(mocks.prompts).toHaveLength(0);
    } finally {
      mocks.restore();
      clearSendIntentsForTests();
      useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    }
  });
});

describe('routeMessage stable fingerprint rejects changed attachments and runtime', () => {
  test('same operation id with different ready ids or different runtime never reuses old files', async () => {
    const { sessionId } = seedPiStore('epoch-1');
    const store = getPiSessionStore();
    const prompts: unknown[][] = [];
    let uploads = 0;
    const originalPrompt = store.prompt.bind(store);
    const originalUpload = store.uploadFile.bind(store);
    (store as unknown as { prompt: unknown }).prompt = (async (...args: unknown[]) => {
      prompts.push(args);
      return { accepted: true, messageId: 'm-1' };
    }) as typeof store.prompt;
    (store as unknown as { uploadFile: unknown }).uploadFile = (async () => {
      uploads += 1;
      return { id: `uploaded-${uploads}`, name: 'x', mime: 'text/plain', size: 1, expiresAt: Date.now() + 60_000 };
    }) as typeof store.uploadFile;
    try {
      clearSendIntentsForTests();
      const operationId = 'op-fingerprint-1';
      const base = {
        sessionId,
        directory: '/repo',
        content: 'hello',
        providerID: 'provider',
        modelID: 'model',
        operationId,
      };
      await routeMessage({
        ...base,
        files: [{ type: 'file', mime: 'image/png', filename: 'a.png', url: '', uploadState: { status: 'ready', attachmentId: 'opaque-1', expiresAt: Date.now() + 60_000 } }],
      });
      expect(prompts).toHaveLength(1);
      expect(uploads).toBe(0);
      await expect(routeMessage({
        ...base,
        files: [{ type: 'file', mime: 'image/png', filename: 'a.png', url: '', uploadState: { status: 'ready', attachmentId: 'opaque-2', expiresAt: Date.now() + 60_000 } }],
      })).rejects.toThrow('different attachments');
      expect(prompts).toHaveLength(1);
      expect(uploads).toBe(0);
      await expect(routeMessage({
        ...base,
        runtimeKey: 'runtime-other',
        files: [{ type: 'file', mime: 'image/png', filename: 'a.png', url: '', uploadState: { status: 'ready', attachmentId: 'opaque-1', expiresAt: Date.now() + 60_000 } }],
      })).rejects.toThrow('different runtime');
      expect(prompts).toHaveLength(1);
      expect(uploads).toBe(0);
    } finally {
      (store as unknown as { prompt: unknown }).prompt = originalPrompt;
      (store as unknown as { uploadFile: unknown }).uploadFile = originalUpload;
      clearSendIntentsForTests();
    }
  });

  test('same data payload may retry without re-upload; different data rejects', async () => {
    const { sessionId } = seedPiStore('epoch-1');
    const store = getPiSessionStore();
    const prompts: unknown[][] = [];
    let uploads = 0;
    const originalPrompt = store.prompt.bind(store);
    const originalUpload = store.uploadFile.bind(store);
    (store as unknown as { prompt: unknown }).prompt = (async (...args: unknown[]) => {
      prompts.push(args);
      return { accepted: true, messageId: 'm-1' };
    }) as typeof store.prompt;
    (store as unknown as { uploadFile: unknown }).uploadFile = (async (_blob: Blob, input: { filename: string; mime: string }) => {
      uploads += 1;
      return { id: `uploaded-${uploads}`, name: input.filename, mime: input.mime, size: 5, expiresAt: Date.now() + 60_000 };
    }) as typeof store.uploadFile;
    try {
      clearSendIntentsForTests();
      const operationId = 'op-fingerprint-data-1';
      const base = {
        sessionId,
        directory: '/repo',
        content: 'hello',
        providerID: 'provider',
        modelID: 'model',
        operationId,
      };
      const dataUrl = 'data:text/plain;base64,aGVsbG8=';
      await routeMessage({ ...base, files: [{ type: 'file', mime: 'text/plain', filename: 'a.txt', url: dataUrl }] });
      expect(uploads).toBe(1);
      expect(prompts).toHaveLength(1);
      await routeMessage({ ...base, files: [{ type: 'file', mime: 'text/plain', filename: 'a.txt', url: dataUrl }] });
      expect(uploads).toBe(1);
      expect(prompts).toHaveLength(2);
      expect((prompts[0] as unknown[])[3]).toEqual((prompts[1] as unknown[])[3]);
      await expect(routeMessage({
        ...base,
        files: [{ type: 'file', mime: 'text/plain', filename: 'a.txt', url: 'data:text/plain;base64,ZGlmZmVyZW50' }],
      })).rejects.toThrow('different attachments');
      expect(uploads).toBe(1);
      expect(prompts).toHaveLength(2);
    } finally {
      (store as unknown as { prompt: unknown }).prompt = originalPrompt;
      (store as unknown as { uploadFile: unknown }).uploadFile = originalUpload;
      clearSendIntentsForTests();
    }
  });
});

describe('queued payload builder still carries the first entry only', () => {
  test('buildQueuedAutoSendPayload is unchanged for text-only queues', () => {
    const payload = buildQueuedAutoSendPayload([{ id: 'queued-1', content: 'hello', createdAt: 1 }]);
    expect(payload?.queuedMessageId).toBe('queued-1');
    expect(payload?.primaryText).toBe('hello');
  });
});
