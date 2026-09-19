import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { GitAPI } from '@/lib/api/types';
import type { DraftWorktreeIntent } from '@/sync/session-ui-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

let mockCurrentDirectory: string | null = '/other';
let mockCurrentSessionId: string | null = null;
let mockNewSessionDirectory: string | null = '/other';
const openDraftCalls: Array<unknown> = [];

mock.module('@/components/chat/composer/state/worktreeName', () => ({
  deriveWorktreeName: async () => 'named-tree',
}));

mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({ currentDirectory: mockCurrentDirectory }),
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: mockCurrentSessionId,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: true,
        directoryOverride: mockNewSessionDirectory,
      },
      getDirectoryForSession: () => null,
      openNewSessionDraft: (options: unknown) => {
        openDraftCalls.push(options);
      },
    }),
  },
}));

const { useWorktreeCreationStore } = await import('@/stores/useWorktreeCreationStore');
const { useInputStore } = await import('@/sync/input-store');
const { restoreWorktreeFailedSend, applyPendingWorktreeRestore } = await import(
  '../worktreeFailedSend'
);
const { readChatDraft, writeChatDraft, createChatDraftIdentity } = await import(
  '@/lib/chatDraftPersistence'
);
const { getDeferredSafeStorage } = await import('@/stores/utils/safeStorage');

const intent = (overrides: Partial<DraftWorktreeIntent> = {}): DraftWorktreeIntent => ({
  runtimeKey: getRuntimeKey(),
  projectRoot: '/repo',
  sourceDirectory: '/repo',
  startRef: 'main',
  ...overrides,
});

const readyFile = (id: string): AttachedFile => ({
  id,
  file: new File(['payload'], `${id}.txt`, { type: 'text/plain' }),
  dataUrl: 'data:text/plain;base64,cGF5bG9hZA==',
  mimeType: 'text/plain',
  filename: `${id}.txt`,
  size: 7,
  source: 'local',
  uploadState: { status: 'ready', attachmentId: `opaque-${id}`, expiresAt: Date.now() + 60_000 },
});

const failingGit = (): GitAPI =>
  ({
    createGitWorktree: async () => {
      throw new Error('disk full');
    },
    getGitWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready' }),
  }) as unknown as GitAPI;

const targetIdentityFor = (sourceDirectory: string) =>
  createChatDraftIdentity(getRuntimeKey(), sourceDirectory, null)!;

const resetAll = (): void => {
  useWorktreeCreationStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  useInputStore.setState({
    attachedFiles: [],
    stashedAttachmentsByDraft: {},
    activeAttachmentsDraftKey: null,
    pendingWorktreeRestore: null,
  });
  getDeferredSafeStorage().removeItem('pichamber.chatDrafts.v2');
  openDraftCalls.length = 0;
};

const failTaskWith = async (
  taskId: string,
  failedSend: { prompt: string; confirmedMentions: string[]; attachments: AttachedFile[] },
  taskIntent?: DraftWorktreeIntent,
): Promise<void> => {
  await expect(
    useWorktreeCreationStore.getState().request({
      taskId,
      intent: taskIntent ?? intent(),
      prompt: failedSend.prompt,
      failedSend,
      git: failingGit(),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    }),
  ).rejects.toThrow('disk full');
};

describe('failed worktree send restore', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://a.example', runtimeKey: 'runtime-a' });
    mockCurrentDirectory = '/other';
    mockCurrentSessionId = null;
    mockNewSessionDirectory = '/other';
    resetAll();
  });

  test('restores prompt plus confirmed mentions into the original directory draft', async () => {
    await failTaskWith('draft-mentions', {
      prompt: 'fix the flaky test @src/a.ts',
      confirmedMentions: ['src/a.ts'],
      attachments: [],
    });

    const result = restoreWorktreeFailedSend('draft-mentions');
    expect(result.ok).toBe(true);

    const restored = readChatDraft(targetIdentityFor('/repo'));
    expect(restored.text).toBe('fix the flaky test @src/a.ts');
    expect([...restored.confirmedMentions]).toEqual(['src/a.ts']);
    const opened = openDraftCalls[0] as { directoryOverride?: unknown; worktreeIntent?: { sourceDirectory?: unknown } };
    expect(opened.directoryOverride).toBe('/repo');
    expect(opened.worktreeIntent?.sourceDirectory).toBe('/repo');
  });

  test('restores one attachment through the missing-ID path', async () => {
    await failTaskWith('draft-one-file', {
      prompt: 'review this',
      confirmedMentions: [],
      attachments: [readyFile('a')],
    });

    expect(restoreWorktreeFailedSend('draft-one-file').ok).toBe(true);
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['a']);
    expect(useInputStore.getState().attachedFiles[0].previewUrl).toBeUndefined();
    expect(useInputStore.getState().attachedFiles[0].dataUrl.startsWith('data:')).toBe(true);
  });

  test('restores many attachments and preserves a newer draft file', async () => {
    useInputStore.setState({
      attachedFiles: [readyFile('new')],
      activeAttachmentsDraftKey: JSON.stringify([getRuntimeKey(), '/other', null]),
    });

    await failTaskWith('draft-many-files', {
      prompt: 'review these',
      confirmedMentions: [],
      attachments: [readyFile('a'), readyFile('b')],
    });

    expect(restoreWorktreeFailedSend('draft-many-files').ok).toBe(true);
    expect(useInputStore.getState().attachedFiles.map((file) => file.id).sort()).toEqual(['a', 'b']);
    expect(
      useInputStore.getState().stashedAttachmentsByDraft[JSON.stringify([getRuntimeKey(), '/other', null])]?.map(
        (file) => file.id,
      ),
    ).toEqual(['new']);
  });

  test('does not overwrite persisted newer draft text', async () => {
    await failTaskWith('draft-occupied', {
      prompt: 'stale prompt',
      confirmedMentions: [],
      attachments: [],
    });

    const target = targetIdentityFor('/repo');
    writeChatDraft(target, 'newer draft text', []);

    const result = restoreWorktreeFailedSend('draft-occupied');
    expect(result).toEqual({ ok: false, reason: 'target-occupied' });
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-occupied')?.failedSend?.prompt).toBe(
      'stale prompt',
    );
    expect(readChatDraft(target).text).toBe('newer draft text');
    expect(openDraftCalls).toEqual([]);
  });

  test('restore-once: a second restore finds no record', async () => {
    await failTaskWith('draft-once', {
      prompt: 'once',
      confirmedMentions: [],
      attachments: [],
    });

    expect(restoreWorktreeFailedSend('draft-once').ok).toBe(true);
    expect(restoreWorktreeFailedSend('draft-once')).toEqual({ ok: false, reason: 'missing' });
  });

  test('dismiss releases the retained snapshot', async () => {
    await failTaskWith('draft-dismiss', {
      prompt: 'dismiss me',
      confirmedMentions: [],
      attachments: [readyFile('a')],
    });

    useWorktreeCreationStore.getState().dismissFailed('draft-dismiss');
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-dismiss')).toBeNull();
    expect(restoreWorktreeFailedSend('draft-dismiss')).toEqual({ ok: false, reason: 'missing' });
  });

  test('runtime reset releases retained records', async () => {
    await failTaskWith('draft-reset', {
      prompt: 'reset me',
      confirmedMentions: [],
      attachments: [],
    });

    useWorktreeCreationStore.getState().resetForRuntimeSwitch('runtime-b');
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-reset')).toBeNull();
  });

  test('runtime mismatch keeps the record instead of restoring into the wrong runtime', async () => {
    await failTaskWith('draft-runtime', {
      prompt: 'do not cross runtimes',
      confirmedMentions: [],
      attachments: [],
    });

    switchRuntimeEndpoint({ apiBaseUrl: 'https://b.example', runtimeKey: 'runtime-b' });
    const result = restoreWorktreeFailedSend('draft-runtime');
    expect(result).toEqual({ ok: false, reason: 'runtime-mismatch' });
    expect(
      useWorktreeCreationStore.getState().getEntryByKey('draft-runtime')?.failedSend?.prompt,
    ).toBe('do not cross runtimes');
    expect(openDraftCalls).toEqual([]);
  });

  test('same-directory restore defers to the composer and preserves live newer text', async () => {
    mockCurrentDirectory = '/repo';
    mockNewSessionDirectory = '/repo';
    useInputStore.setState({
      attachedFiles: [],
      activeAttachmentsDraftKey: JSON.stringify([getRuntimeKey(), '/repo', null]),
    });

    await failTaskWith('draft-same', {
      prompt: 'restore me',
      confirmedMentions: ['src/a.ts'],
      attachments: [readyFile('a')],
    });

    const deferred = restoreWorktreeFailedSend('draft-same');
    expect(deferred).toEqual({ ok: true, reason: 'pending' });
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-same')?.failedSend).toBeTruthy();
    const pending = useInputStore.getState().pendingWorktreeRestore;
    expect(pending?.prompt).toBe('restore me');

    const occupied = applyPendingWorktreeRestore(pending!, 'newer live text');
    expect(occupied).toEqual({ ok: false, reason: 'target-occupied' });
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-same')?.failedSend).toBeTruthy();

    const applied = applyPendingWorktreeRestore(pending!, '');
    expect(applied.ok).toBe(true);
    const restored = readChatDraft(targetIdentityFor('/repo'));
    expect(restored.text).toBe('restore me');
    expect([...restored.confirmedMentions]).toEqual(['src/a.ts']);
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['a']);
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-same')).toBeNull();

    expect(applyPendingWorktreeRestore(pending!, '')).toEqual({ ok: false, reason: 'dismissed' });
  });

  test('retained snapshot is immutable across restore', async () => {
    const live = [readyFile('a')];
    await failTaskWith('draft-immutable', {
      prompt: 'immutable',
      confirmedMentions: [],
      attachments: live,
    });

    live[0].filename = 'mutated.txt';
    expect(restoreWorktreeFailedSend('draft-immutable').ok).toBe(true);
    expect(useInputStore.getState().attachedFiles[0].filename).toBe('a.txt');
  });

  test('deferred restore does not clear a newer in-flight generation under the same key', async () => {
    mockCurrentDirectory = '/repo';
    mockNewSessionDirectory = '/repo';
    useInputStore.setState({
      attachedFiles: [],
      activeAttachmentsDraftKey: JSON.stringify([getRuntimeKey(), '/repo', null]),
    });

    await failTaskWith('draft-race-pending', {
      prompt: 'old prompt',
      confirmedMentions: [],
      attachments: [],
    });
    expect(restoreWorktreeFailedSend('draft-race-pending')).toEqual({ ok: true, reason: 'pending' });
    const stalePending = useInputStore.getState().pendingWorktreeRestore;
    expect(stalePending?.prompt).toBe('old prompt');

    // Retry the same task: naming/in-flight structurally clears the old payload.
    let releaseCreate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const blocking = {
      createGitWorktree: async () => {
        await gate;
        return {
          head: 'abc',
          name: 'named-tree',
          branch: 'pichamber/named-tree',
          path: '/worktrees/named-tree',
          directoryCreated: true,
          bootstrapStatus: { status: 'ready', phase: 'setup-ready' },
        };
      },
      getGitWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready' }),
    } as unknown as GitAPI;
    const retry = useWorktreeCreationStore.getState().request({
      taskId: 'draft-race-pending',
      intent: intent(),
      prompt: 'new prompt',
      failedSend: { prompt: 'new prompt', confirmedMentions: [], attachments: [] },
      git: blocking,
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const live = useWorktreeCreationStore.getState().getEntryByKey('draft-race-pending');
      if (live?.state && live.state.phase !== 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-race-pending')?.failedSend).toBeNull();

    // The stale deferred pending must not consume the new generation or write old text.
    expect(applyPendingWorktreeRestore(stalePending!, '')).toEqual({ ok: false, reason: 'dismissed' });
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-race-pending')).not.toBeNull();
    expect(readChatDraft(targetIdentityFor('/repo')).text).toBe('');

    releaseCreate?.();
    await retry;
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-race-pending')?.receipt?.path).toBe(
      '/worktrees/named-tree',
    );
    // Still stale after completion: must not delete the receipt.
    expect(applyPendingWorktreeRestore(stalePending!, '')).toEqual({ ok: false, reason: 'dismissed' });
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-race-pending')?.receipt).toBeTruthy();
  });

  test('immediate restore does not clear a newer in-flight generation', async () => {
    // Different-directory path: current draft stays on /other, target is /repo.
    await failTaskWith('draft-race-immediate', {
      prompt: 'old prompt',
      confirmedMentions: [],
      attachments: [],
    });
    const oldFailed = useWorktreeCreationStore.getState().getEntryByKey('draft-race-immediate')?.failedSend;
    expect(oldFailed).toBeTruthy();

    let releaseCreate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const blocking = {
      createGitWorktree: async () => {
        await gate;
        throw new Error('new failure');
      },
      getGitWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready' }),
    } as unknown as GitAPI;
    const retry = useWorktreeCreationStore.getState().request({
      taskId: 'draft-race-immediate',
      intent: intent(),
      prompt: 'new prompt',
      failedSend: { prompt: 'new prompt', confirmedMentions: [], attachments: [] },
      git: blocking,
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const live = useWorktreeCreationStore.getState().getEntryByKey('draft-race-immediate');
      if (live?.state && live.state.phase !== 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // In-flight has no failed payload, so an immediate restore finds no record and preserves it.
    expect(restoreWorktreeFailedSend('draft-race-immediate')).toEqual({ ok: false, reason: 'missing' });
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-race-immediate')).not.toBeNull();
    // Guarded consume with the stale token also refuses.
    expect(useWorktreeCreationStore.getState().consumeFailedSend('draft-race-immediate', oldFailed!)).toBe(false);

    releaseCreate?.();
    await expect(retry).rejects.toThrow('new failure');
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-race-immediate')?.failedSend?.prompt).toBe(
      'new prompt',
    );
  });

  test('runtime endpoint reset clears deferred pending restores', async () => {
    mockCurrentDirectory = '/repo';
    mockNewSessionDirectory = '/repo';
    useInputStore.setState({
      attachedFiles: [],
      activeAttachmentsDraftKey: JSON.stringify([getRuntimeKey(), '/repo', null]),
    });
    await failTaskWith('draft-pending-reset', {
      prompt: 'pending prompt',
      confirmedMentions: [],
      attachments: [],
    });
    expect(restoreWorktreeFailedSend('draft-pending-reset')).toEqual({ ok: true, reason: 'pending' });
    expect(useInputStore.getState().pendingWorktreeRestore?.prompt).toBe('pending prompt');

    useInputStore.getState().resetForRuntimeSwitch();
    expect(useInputStore.getState().pendingWorktreeRestore).toBeNull();
  });

  test('explicit restore overflow keeps the record and reports counts', async () => {
    // Different-directory restore activates the target draft first: seed the
    // target stash so the post-activate visible list overflows on append.
    const targetKey = JSON.stringify([getRuntimeKey(), '/repo', null]);
    const crowdedTarget = Array.from({ length: 19 }, (_, index) => readyFile(`v${index}`));
    useInputStore.setState({
      attachedFiles: [],
      stashedAttachmentsByDraft: { [targetKey]: crowdedTarget },
      activeAttachmentsDraftKey: JSON.stringify([getRuntimeKey(), '/other', null]),
    });
    await failTaskWith('draft-overflow', {
      prompt: 'overflow prompt',
      confirmedMentions: [],
      attachments: [readyFile('a'), readyFile('b')],
    });

    const result = restoreWorktreeFailedSend('draft-overflow');
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'attachment-limit') {
      expect(result.limit).toBe(20);
      expect(result.currentCount).toBe(19);
      expect(result.missingCount).toBe(2);
    } else {
      throw new Error('expected attachment-limit overflow');
    }
    expect(useInputStore.getState().attachedFiles.map((file) => file.id).sort()).toEqual(
      crowdedTarget.map((file) => file.id).sort(),
    );
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-overflow')?.failedSend?.prompt).toBe(
      'overflow prompt',
    );
  });

  test('exact limit restore succeeds and consumes the record', async () => {
    const targetKey = JSON.stringify([getRuntimeKey(), '/repo', null]);
    const nearFullTarget = Array.from({ length: 18 }, (_, index) => readyFile(`v${index}`));
    useInputStore.setState({
      attachedFiles: [],
      stashedAttachmentsByDraft: { [targetKey]: nearFullTarget },
      activeAttachmentsDraftKey: JSON.stringify([getRuntimeKey(), '/other', null]),
    });
    await failTaskWith('draft-exact-limit', {
      prompt: 'exact prompt',
      confirmedMentions: [],
      attachments: [readyFile('a'), readyFile('b')],
    });

    const result = restoreWorktreeFailedSend('draft-exact-limit');
    expect(result.ok).toBe(true);
    expect(useInputStore.getState().attachedFiles).toHaveLength(20);
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-exact-limit')).toBeNull();
  });

  test('deferred restore overflow keeps the record for retry', async () => {
    mockCurrentDirectory = '/repo';
    mockNewSessionDirectory = '/repo';
    useInputStore.setState({
      attachedFiles: [],
      activeAttachmentsDraftKey: JSON.stringify([getRuntimeKey(), '/repo', null]),
    });
    await failTaskWith('draft-deferred-overflow', {
      prompt: 'deferred overflow',
      confirmedMentions: [],
      attachments: [readyFile('a'), readyFile('b')],
    });
    expect(restoreWorktreeFailedSend('draft-deferred-overflow')).toEqual({ ok: true, reason: 'pending' });
    const pending = useInputStore.getState().pendingWorktreeRestore;
    expect(pending?.prompt).toBe('deferred overflow');

    const crowded = Array.from({ length: 19 }, (_, index) => readyFile(`v${index}`));
    useInputStore.setState({ attachedFiles: crowded });
    const beforeVisible = [...useInputStore.getState().attachedFiles];

    const result = applyPendingWorktreeRestore(pending!, '');
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'attachment-limit') {
      expect(result.limit).toBe(20);
      expect(result.currentCount).toBe(19);
      expect(result.missingCount).toBe(2);
    } else {
      throw new Error('expected attachment-limit overflow');
    }
    expect(useInputStore.getState().attachedFiles).toEqual(beforeVisible);
    expect(
      useWorktreeCreationStore.getState().getEntryByKey('draft-deferred-overflow')?.failedSend?.prompt,
    ).toBe('deferred overflow');
  });

  test('expired upload ids stay refreshable through explicit restore', async () => {
    const expired = readyFile('expired');
    (expired.uploadState as { expiresAt: number }).expiresAt = Date.now() - 1_000;
    await failTaskWith('draft-expired', {
      prompt: 'expired prompt',
      confirmedMentions: [],
      attachments: [expired],
    });

    expect(restoreWorktreeFailedSend('draft-expired').ok).toBe(true);
    const restored = useInputStore.getState().attachedFiles.find((file) => file.id === 'expired');
    expect(restored?.previewUrl).toBeUndefined();
    expect(restored?.dataUrl.startsWith('data:')).toBe(true);
    expect(restored?.uploadState).toMatchObject({ status: 'ready', attachmentId: 'opaque-expired' });
  });
});
