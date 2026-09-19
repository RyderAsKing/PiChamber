import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { GitAPI } from '@/lib/api/types';
import type { DraftWorktreeIntent } from '@/sync/session-ui-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

mock.module('@/components/chat/composer/state/worktreeName', () => ({
  deriveWorktreeName: async () => 'named-tree',
}));

const { useWorktreeCreationStore } = await import('@/stores/useWorktreeCreationStore');
const { useInputStore } = await import('@/sync/input-store');
const {
  canOfferCompletedWorktreeActions,
  isWorktreePromptPending,
  isWorktreeTaskCompleted,
  settleWorktreePromptForConsumedLocalCommand,
  settleWorktreePromptForEmptyDispatch,
  shouldNotifyWorktreeReady,
} = await import('../worktreeFailedSend');

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

const succeedingGit = (path = '/worktrees/named-tree'): GitAPI =>
  ({
    createGitWorktree: async () => ({
      head: 'abc',
      name: 'named-tree',
      branch: 'pichamber/named-tree',
      path,
      directoryCreated: true,
      bootstrapStatus: { status: 'ready', phase: 'setup-ready' },
    }),
    getGitWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready' }),
  }) as unknown as GitAPI;

const resetAll = (): void => {
  useWorktreeCreationStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  useInputStore.setState({
    attachedFiles: [],
    stashedAttachmentsByDraft: {},
    activeAttachmentsDraftKey: null,
    pendingWorktreeRestore: null,
  });
};

describe('prompt-dispatch-pending lifecycle', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://a.example', runtimeKey: 'runtime-a' });
    resetAll();
  });

  test('pending means receipt plus retained snapshot with no lifecycle state', () => {
    const pending = { receipt: { path: '/w' } as never, failedSend: { prompt: 'p' } as never, state: null };
    const completed = { receipt: { path: '/w' } as never, failedSend: null, state: null };
    const failedPostReceipt = {
      receipt: { path: '/w' } as never,
      failedSend: { prompt: 'p' } as never,
      state: { phase: 'failed', label: 'Prompt failed to send' } as never,
    };
    const active = { receipt: null, failedSend: null, state: { phase: 'creating', label: 'Creating' } as never };
    const noReceipt = { receipt: null, failedSend: { prompt: 'p' } as never, state: null };

    expect(isWorktreePromptPending(pending)).toBe(true);
    expect(isWorktreePromptPending(completed)).toBe(false);
    expect(isWorktreePromptPending(failedPostReceipt)).toBe(false);
    expect(isWorktreePromptPending(active)).toBe(false);
    expect(isWorktreePromptPending(noReceipt)).toBe(false);
    expect(isWorktreePromptPending(null)).toBe(false);
    expect(isWorktreePromptPending(undefined)).toBe(false);
  });

  test('only completed entries may offer Open or completed-dismiss actions', () => {
    const pending = { receipt: { path: '/w' } as never, failedSend: { prompt: 'p' } as never, state: null };
    const completed = { receipt: { path: '/w' } as never, failedSend: null, state: null };
    const failed = {
      receipt: { path: '/w' } as never,
      failedSend: { prompt: 'p' } as never,
      state: { phase: 'failed', label: 'x' } as never,
    };
    const active = { receipt: null, failedSend: null, state: { phase: 'creating', label: 'x' } as never };

    // Pending must not be opened/dismissed through completed controls: the
    // snapshot would be deleted while prompt dispatch is unsettled.
    expect(canOfferCompletedWorktreeActions(pending)).toBe(false);
    expect(isWorktreeTaskCompleted(pending)).toBe(false);
    expect(canOfferCompletedWorktreeActions(completed)).toBe(true);
    expect(isWorktreeTaskCompleted(completed)).toBe(true);
    expect(canOfferCompletedWorktreeActions(failed)).toBe(false);
    expect(canOfferCompletedWorktreeActions(active)).toBe(false);
  });

  test('only completed entries announce Worktree ready', () => {
    const completedUnnotified = {
      receipt: { path: '/w', branch: 'b' } as never,
      failedSend: null,
      state: null,
      notificationSent: false,
    };
    const pendingUnnotified = {
      receipt: { path: '/w', branch: 'b' } as never,
      failedSend: { prompt: 'p' } as never,
      state: null,
      notificationSent: false,
    };
    const failedPostReceipt = {
      receipt: { path: '/w', branch: 'b' } as never,
      failedSend: { prompt: 'p' } as never,
      state: { phase: 'failed', label: 'x' } as never,
      notificationSent: false,
    };
    const alreadyNotified = { ...completedUnnotified, notificationSent: true };
    const active = { receipt: null, failedSend: null, state: { phase: 'creating', label: 'x' } as never, notificationSent: false };

    expect(shouldNotifyWorktreeReady(completedUnnotified)).toBe(true);
    // Prompt-pending entries must not emit a ready toast.
    expect(shouldNotifyWorktreeReady(pendingUnnotified)).toBe(false);
    expect(shouldNotifyWorktreeReady(failedPostReceipt)).toBe(false);
    expect(shouldNotifyWorktreeReady(alreadyNotified)).toBe(false);
    expect(shouldNotifyWorktreeReady(active)).toBe(false);
  });

  test('empty dispatch transitions pending to failed recovery with snapshot intact', async () => {
    const taskId = 'draft-empty-settles';
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'pending prompt',
      failedSend: { prompt: 'pending prompt', confirmedMentions: ['src/a.ts'], attachments: [readyFile('a')] },
      git: succeedingGit(),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const expected = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    expect(expected?.prompt).toBe('pending prompt');
    expect(isWorktreePromptPending(useWorktreeCreationStore.getState().getEntryByKey(taskId))).toBe(true);

    expect(settleWorktreePromptForEmptyDispatch(taskId, expected!, 'Prompt was empty and was not sent.')).toBe(true);

    const failed = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(failed?.state?.phase).toBe('failed');
    expect(failed?.state?.error).toBe('Prompt was empty and was not sent.');
    expect(failed?.receipt?.path).toBe('/worktrees/named-tree');
    expect(failed?.failedSend).toBe(expected);
    expect(isWorktreePromptPending(failed)).toBe(false);
    // Failed recovery stays restorable, never silently dropped.
    expect(failed?.failedSend?.attachments.map((file) => file.id)).toEqual(['a']);
  });

  test('empty dispatch with a stale generation never overwrites a newer one', async () => {
    const taskId = 'draft-empty-stale';
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'old',
      failedSend: { prompt: 'old', confirmedMentions: [], attachments: [] },
      git: succeedingGit('/worktrees/old'),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const stale = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'new',
      failedSend: { prompt: 'new', confirmedMentions: [], attachments: [] },
      git: succeedingGit('/worktrees/new'),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });

    expect(settleWorktreePromptForEmptyDispatch(taskId, stale!, 'stale')).toBe(false);
    const current = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(current?.state).toBeNull();
    expect(current?.failedSend?.prompt).toBe('new');
    expect(settleWorktreePromptForEmptyDispatch(taskId, null, 'missing')).toBe(false);
  });

  test('consumed local command clears the exact generation and only captured files', async () => {
    const taskId = 'draft-consumed-command';
    const captured = [readyFile('a'), readyFile('b')];
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: '/compact',
      failedSend: { prompt: '/compact', confirmedMentions: [], attachments: captured },
      git: succeedingGit(),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const expected = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    expect(isWorktreePromptPending(useWorktreeCreationStore.getState().getEntryByKey(taskId))).toBe(true);

    // Simulate the draft switch: captured files stashed, fresh draft holds newer file.
    useInputStore.setState({
      attachedFiles: [readyFile('new')],
      stashedAttachmentsByDraft: { 'draft-source': [readyFile('a'), readyFile('b')] },
      activeAttachmentsDraftKey: 'draft-fresh',
    });

    expect(
      settleWorktreePromptForConsumedLocalCommand(taskId, expected!, captured, useInputStore.getState().attachedFiles),
    ).toBe(true);

    // Exact generation consumed: no retry remains that could re-execute the command.
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)).toBeNull();
    // Only captured ownership cleaned; newer-draft files survive everywhere.
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['new']);
    expect(useInputStore.getState().stashedAttachmentsByDraft['draft-source'] ?? []).toEqual([]);
  });

  test('consumed local command with no capture leaves visible files for the next prompt', async () => {
    const taskId = 'draft-consumed-no-capture';
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: '/compact',
      failedSend: { prompt: '/compact', confirmedMentions: [], attachments: [] },
      git: succeedingGit(),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const expected = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    useInputStore.setState({ attachedFiles: [readyFile('keep')] });

    expect(settleWorktreePromptForConsumedLocalCommand(taskId, expected!, null, useInputStore.getState().attachedFiles)).toBe(
      true,
    );
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)).toBeNull();
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['keep']);
  });

  test('consumed local command with a stale generation preserves the newer task', async () => {
    const taskId = 'draft-consumed-stale';
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'old',
      failedSend: { prompt: 'old', confirmedMentions: [], attachments: [] },
      git: succeedingGit('/worktrees/old'),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const stale = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'new',
      failedSend: { prompt: 'new', confirmedMentions: [], attachments: [] },
      git: succeedingGit('/worktrees/new'),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });

    useInputStore.setState({ attachedFiles: [readyFile('new-visible')] });
    expect(
      settleWorktreePromptForConsumedLocalCommand(taskId, stale!, [readyFile('old')], useInputStore.getState().attachedFiles),
    ).toBe(false);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend?.prompt).toBe('new');
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['new-visible']);
  });
});
