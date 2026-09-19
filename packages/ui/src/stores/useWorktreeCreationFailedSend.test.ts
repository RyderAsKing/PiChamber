import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { GitAPI } from '@/lib/api/types';
import type { DraftWorktreeIntent } from '@/sync/session-ui-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';

let runtimeKey = 'runtime-a';

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
}));

mock.module('@/components/chat/composer/state/worktreeName', () => ({
  deriveWorktreeName: async () => 'named-tree',
}));

const { useWorktreeCreationStore } = await import('./useWorktreeCreationStore');

const intent = (overrides: Partial<DraftWorktreeIntent> = {}): DraftWorktreeIntent => ({
  runtimeKey,
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

describe('worktree failed-send retention (red regression for PR #149 r4051037134)', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    useWorktreeCreationStore.getState().resetForRuntimeSwitch(runtimeKey);
  });

  test('a failed background creation retains the prompt, mentions, and attachment snapshot in task state', async () => {
    const taskId = 'draft-background-fail';
    const failedSend = {
      prompt: 'fix the flaky test @src/a.ts',
      confirmedMentions: ['src/a.ts'],
      attachments: [readyFile('a')],
    };

    await expect(
      useWorktreeCreationStore.getState().request({
        taskId,
        intent: intent(),
        prompt: failedSend.prompt,
        failedSend,
        git: failingGit(),
        refreshProject: async () => undefined,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('disk full');

    const entry = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(entry?.state?.phase).toBe('failed');
    // Task-owned retention: prompt + mentions + immutable attachment snapshot.
    expect(entry?.failedSend?.prompt).toBe(failedSend.prompt);
    expect(entry?.failedSend?.confirmedMentions).toEqual(['src/a.ts']);
    expect(entry?.failedSend?.attachments.map((file) => file.id)).toEqual(['a']);
    // Immutable: mutating the caller's array must not reach the retained snapshot.
    failedSend.attachments[0].filename = 'mutated.txt';
    expect(entry?.failedSend?.attachments[0].filename).toBe('a.txt');
  });

  test('clears stale failedSend when a failed entry retries into naming/in-flight', async () => {
    const taskId = 'draft-retry-clears';
    await expect(
      useWorktreeCreationStore.getState().request({
        taskId,
        intent: intent(),
        prompt: 'old prompt',
        failedSend: { prompt: 'old prompt', confirmedMentions: [], attachments: [] },
        git: failingGit(),
        refreshProject: async () => undefined,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('disk full');
    const oldFailed = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    expect(oldFailed?.prompt).toBe('old prompt');

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
      taskId,
      intent: intent(),
      prompt: 'new prompt',
      failedSend: { prompt: 'new prompt', confirmedMentions: [], attachments: [] },
      git: blocking,
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    // Wait until the retry has re-entered naming/in-flight.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const live = useWorktreeCreationStore.getState().getEntryByKey(taskId);
      if (live?.state && live.state.phase !== 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const inFlight = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(inFlight?.state?.phase).not.toBe('failed');
    // Structural clear: the previous generation's payload must not linger.
    expect(inFlight?.failedSend).toBeNull();
    // Guarded consume with the stale token must not delete the new generation.
    expect(useWorktreeCreationStore.getState().consumeFailedSend(taskId, oldFailed!)).toBe(false);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)).not.toBeNull();

    releaseCreate?.();
    await retry;
    const done = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(done?.receipt?.path).toBe('/worktrees/named-tree');
    // Receipt retains the task-owned snapshot until prompt dispatch settles.
    expect(done?.failedSend?.prompt).toBe('new prompt');
  });

  test('guarded consume deletes only the same failed payload it read', async () => {
    const taskId = 'draft-consume-guard';
    await expect(
      useWorktreeCreationStore.getState().request({
        taskId,
        intent: intent(),
        prompt: 'same text',
        failedSend: { prompt: 'same text', confirmedMentions: [], attachments: [] },
        git: failingGit(),
        refreshProject: async () => undefined,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('disk full');
    const entry = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    const expected = entry?.failedSend;
    expect(expected).toBeTruthy();
    // Same prompt text but different identity must not consume.
    expect(
      useWorktreeCreationStore.getState().consumeFailedSend(taskId, {
        prompt: 'same text',
        confirmedMentions: [],
        attachments: [],
      }),
    ).toBe(false);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend).toBe(expected);
    expect(useWorktreeCreationStore.getState().consumeFailedSend(taskId, expected!)).toBe(true);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)).toBeNull();
    expect(useWorktreeCreationStore.getState().consumeFailedSend(taskId, expected!)).toBe(false);
  });

  test('a newer failure supersedes the old payload; the old token cannot delete it', async () => {
    const taskId = 'draft-supersede';
    await expect(
      useWorktreeCreationStore.getState().request({
        taskId,
        intent: intent(),
        prompt: 'old prompt',
        failedSend: { prompt: 'old prompt', confirmedMentions: [], attachments: [] },
        git: failingGit(),
        refreshProject: async () => undefined,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('disk full');
    const oldFailed = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    await expect(
      useWorktreeCreationStore.getState().request({
        taskId,
        intent: intent(),
        prompt: 'new prompt',
        failedSend: { prompt: 'new prompt', confirmedMentions: [], attachments: [] },
        git: failingGit(),
        refreshProject: async () => undefined,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('disk full');
    const current = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(current?.failedSend?.prompt).toBe('new prompt');
    expect(useWorktreeCreationStore.getState().consumeFailedSend(taskId, oldFailed!)).toBe(false);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend?.prompt).toBe('new prompt');
    const newFailed = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    expect(newFailed).toBeTruthy();
    expect(useWorktreeCreationStore.getState().consumeFailedSend(taskId, newFailed!)).toBe(true);
  });

  test('a newer completed receipt survives a stale failed consume', async () => {
    const taskId = 'draft-receipt-guard';
    await expect(
      useWorktreeCreationStore.getState().request({
        taskId,
        intent: intent(),
        prompt: 'old prompt',
        failedSend: { prompt: 'old prompt', confirmedMentions: [], attachments: [] },
        git: failingGit(),
        refreshProject: async () => undefined,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('disk full');
    const oldFailed = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'retry',
      git: succeedingGit(),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const done = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(done?.receipt?.path).toBe('/worktrees/named-tree');
    expect(done?.failedSend).toBeNull();
    expect(useWorktreeCreationStore.getState().consumeFailedSend(taskId, oldFailed!)).toBe(false);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)?.receipt?.path).toBe('/worktrees/named-tree');
  });

  test('a successful receipt retains the task snapshot while prompt dispatch is pending', async () => {
    const taskId = 'draft-receipt-retains';
    const failedSend = {
      prompt: 'ship the worktree prompt',
      confirmedMentions: ['src/a.ts'],
      attachments: [readyFile('a')],
    };
    const receipt = await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: failedSend.prompt,
      failedSend,
      git: succeedingGit(),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    expect(receipt.path).toBe('/worktrees/named-tree');
    const entry = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(entry?.receipt?.path).toBe('/worktrees/named-tree');
    expect(entry?.state).toBeNull();
    expect(entry?.failedSend?.prompt).toBe(failedSend.prompt);
    expect(entry?.failedSend?.confirmedMentions).toEqual(['src/a.ts']);
    expect(entry?.failedSend?.attachments.map((file) => file.id)).toEqual(['a']);
  });

  test('prompt acceptance consumes only the exact receipt generation', async () => {
    const taskId = 'draft-prompt-success';
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'accepted prompt',
      failedSend: { prompt: 'accepted prompt', confirmedMentions: [], attachments: [readyFile('a')] },
      git: succeedingGit(),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const expected = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    expect(expected?.prompt).toBe('accepted prompt');
    expect(useWorktreeCreationStore.getState().markWorktreePromptSucceeded(taskId, expected!)).toBe(true);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)).toBeNull();
    expect(useWorktreeCreationStore.getState().markWorktreePromptSucceeded(taskId, expected!)).toBe(false);
  });

  test('post-receipt prompt failure exposes failed-send recovery with the snapshot intact', async () => {
    const taskId = 'draft-prompt-failure';
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'failing prompt',
      failedSend: { prompt: 'failing prompt', confirmedMentions: ['src/a.ts'], attachments: [readyFile('a')] },
      git: succeedingGit(),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const expected = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    expect(expected?.prompt).toBe('failing prompt');
    expect(useWorktreeCreationStore.getState().markWorktreePromptFailed(taskId, expected!, 'Prompt failed to send.')).toBe(true);
    const failed = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(failed?.state?.phase).toBe('failed');
    expect(failed?.state?.label).toBe('Prompt failed to send');
    expect(failed?.receipt?.path).toBe('/worktrees/named-tree');
    expect(failed?.failedSend).toBe(expected);
    expect(failed?.failedSend?.attachments.map((file) => file.id)).toEqual(['a']);
    expect(useWorktreeCreationStore.getState().consumeFailedSend(taskId, expected!)).toBe(true);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)).toBeNull();
  });

  test('a late prompt success cannot clear a newer generation', async () => {
    const taskId = 'draft-stale-success';
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'old prompt',
      failedSend: { prompt: 'old prompt', confirmedMentions: [], attachments: [] },
      git: succeedingGit('/worktrees/old'),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const stale = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    expect(stale?.prompt).toBe('old prompt');
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'new prompt',
      failedSend: { prompt: 'new prompt', confirmedMentions: [], attachments: [] },
      git: succeedingGit('/worktrees/new'),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const current = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(current?.failedSend?.prompt).toBe('new prompt');
    expect(useWorktreeCreationStore.getState().markWorktreePromptSucceeded(taskId, stale!)).toBe(false);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend?.prompt).toBe('new prompt');
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)?.receipt?.path).toBe('/worktrees/new');
    expect(useWorktreeCreationStore.getState().markWorktreePromptSucceeded(taskId, current!.failedSend!)).toBe(true);
    expect(useWorktreeCreationStore.getState().getEntryByKey(taskId)).toBeNull();
  });

  test('a late prompt failure cannot overwrite a newer generation', async () => {
    const taskId = 'draft-stale-failure';
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'old prompt',
      failedSend: { prompt: 'old prompt', confirmedMentions: [], attachments: [] },
      git: succeedingGit('/worktrees/old'),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    const stale = useWorktreeCreationStore.getState().getEntryByKey(taskId)?.failedSend;
    await useWorktreeCreationStore.getState().request({
      taskId,
      intent: intent(),
      prompt: 'new prompt',
      failedSend: { prompt: 'new prompt', confirmedMentions: [], attachments: [] },
      git: succeedingGit('/worktrees/new'),
      refreshProject: async () => undefined,
      pollIntervalMs: 1,
    });
    expect(useWorktreeCreationStore.getState().markWorktreePromptFailed(taskId, stale!, 'stale failure')).toBe(false);
    const current = useWorktreeCreationStore.getState().getEntryByKey(taskId);
    expect(current?.state).toBeNull();
    expect(current?.failedSend?.prompt).toBe('new prompt');
    expect(current?.receipt?.path).toBe('/worktrees/new');
  });
});
