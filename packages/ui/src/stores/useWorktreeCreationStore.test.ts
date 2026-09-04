import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { GitAPI, GitWorktreeBootstrapStatus, GitWorktreeCreateResult } from '@/lib/api/types';
import type { DraftWorktreeIntent } from '@/sync/session-ui-store';

let runtimeKey = 'runtime-a';

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
}));

mock.module('@/components/chat/composer/state/worktreeName', () => ({
  deriveWorktreeName: async () => 'named-tree',
}));

const { useWorktreeCreationStore, getWorktreeCreationKey } = await import('./useWorktreeCreationStore');

const intent = (overrides: Partial<DraftWorktreeIntent> = {}): DraftWorktreeIntent => ({
  runtimeKey,
  projectRoot: '/repo',
  sourceDirectory: '/repo',
  startRef: 'main',
  ...overrides,
});

const pending = (phase: GitWorktreeBootstrapStatus['phase'] = 'directory-created'): GitWorktreeBootstrapStatus => ({
  status: 'pending',
  phase,
});

const ready = (): GitWorktreeBootstrapStatus => ({
  status: 'ready',
  phase: 'setup-ready',
});

const created = (overrides: Partial<GitWorktreeCreateResult> = {}): GitWorktreeCreateResult => ({
  head: 'abc',
  name: 'named-tree',
  branch: 'pichamber/named-tree',
  path: '/worktrees/named-tree',
  directoryCreated: true,
  bootstrapStatus: pending(),
  ...overrides,
});

const git = (overrides: Partial<GitAPI> = {}): GitAPI => ({
  createGitWorktree: async () => created(),
  getGitWorktreeBootstrapStatus: async () => ready(),
  ...overrides,
} as GitAPI);

const request = (overrides: {
  taskId?: string;
  intent?: DraftWorktreeIntent;
  git?: GitAPI;
  refreshProject?: (projectRoot: string, git: GitAPI) => Promise<unknown>;
} = {}) =>
  useWorktreeCreationStore.getState().request({
    taskId: overrides.taskId,
    intent: overrides.intent ?? intent(),
    prompt: 'named tree',
    git: overrides.git ?? git(),
    refreshProject: overrides.refreshProject ?? (async () => undefined),
    pollIntervalMs: 1,
  });

describe('useWorktreeCreationStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    useWorktreeCreationStore.getState().resetForRuntimeSwitch(runtimeKey);
  });

  test('stores a receipt after bootstrap becomes setup-ready', async () => {
    const receipt = await request();
    const entry = useWorktreeCreationStore.getState().getEntry(intent());

    expect(receipt.path).toBe('/worktrees/named-tree');
    expect(receipt.branch).toBe('pichamber/named-tree');
    expect(entry?.state).toBeNull();
    expect(entry?.receipt).toEqual(receipt);
  });

  test('polls pending bootstrap until setup-ready', async () => {
    let polls = 0;
    const api = git({
      getGitWorktreeBootstrapStatus: async () => {
        polls += 1;
        return polls < 3 ? pending(polls === 1 ? 'directory-created' : 'git-ready') : ready();
      },
    });

    await request({ git: api });
    expect(polls).toBe(3);
    expect(useWorktreeCreationStore.getState().getEntry(intent())?.receipt?.path).toBe('/worktrees/named-tree');
  });

  test('coalesces concurrent requests for the same intent into one create', async () => {
    let creates = 0;
    let releaseCreate: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const api = git({
      createGitWorktree: async () => {
        creates += 1;
        await createStarted;
        return created();
      },
    });

    const first = request({ git: api });
    const second = request({ git: api });
    expect(useWorktreeCreationStore.getState().getActiveEntries()).toHaveLength(1);

    releaseCreate?.();
    const [left, right] = await Promise.all([first, second]);
    expect(creates).toBe(1);
    expect(left).toEqual(right);
  });

  test('tracks separate draft tasks for the same worktree intent', async () => {
    let creates = 0;
    const api = git({
      createGitWorktree: async () => {
        creates += 1;
        return created({
          path: `/worktrees/named-tree-${creates}`,
          branch: `pichamber/named-tree-${creates}`,
        });
      },
    });

    await Promise.all([
      request({ taskId: 'draft-1', git: api }),
      request({ taskId: 'draft-2', git: api }),
    ]);

    expect(creates).toBe(2);
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-1')?.receipt?.path).toBe('/worktrees/named-tree-1');
    expect(useWorktreeCreationStore.getState().getEntryByKey('draft-2')?.receipt?.path).toBe('/worktrees/named-tree-2');
  });

  test('marks a completed task notification once without removing its receipt', async () => {
    await request({ taskId: 'draft-notification' });
    const before = useWorktreeCreationStore.getState().getEntryByKey('draft-notification');
    expect(before?.notificationSent).toBe(false);

    useWorktreeCreationStore.getState().markNotificationSent('draft-notification');
    useWorktreeCreationStore.getState().markNotificationSent('draft-notification');

    const after = useWorktreeCreationStore.getState().getEntryByKey('draft-notification');
    expect(after?.notificationSent).toBe(true);
    expect(after?.receipt?.path).toBe('/worktrees/named-tree');
  });

  test('keeps the receipt when project refresh fails after setup-ready', async () => {
    const receipt = await request({
      refreshProject: async () => {
        throw new Error('refresh failed');
      },
    });

    expect(receipt.path).toBe('/worktrees/named-tree');
    expect(useWorktreeCreationStore.getState().getEntry(intent())?.receipt).toEqual(receipt);
    expect(useWorktreeCreationStore.getState().getEntry(intent())?.state).toBeNull();
  });

  test('records failure without clearing an unrelated intent', async () => {
    const other = intent({ sourceDirectory: '/repo/other', startRef: 'dev' });
    await request({ intent: other });

    await expect(request({
      git: git({
        createGitWorktree: async () => {
          throw new Error('disk full');
        },
      }),
    })).rejects.toThrow('disk full');

    expect(useWorktreeCreationStore.getState().getEntry(intent())?.state?.phase).toBe('failed');
    expect(useWorktreeCreationStore.getState().getEntry(other)?.receipt?.path).toBe('/worktrees/named-tree');
  });

  test('does not overwrite a newer entry after a runtime switch', async () => {
    let startedCreate = false;
    let finishCreate: ((result: GitWorktreeCreateResult) => void) | undefined;
    const api = git({
      createGitWorktree: () => {
        startedCreate = true;
        return new Promise<GitWorktreeCreateResult>((resolve) => {
          finishCreate = resolve;
        });
      },
    });

    const pendingRequest = request({ git: api });
    while (!startedCreate) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useWorktreeCreationStore.getState().getActiveEntries()).toHaveLength(1);

    runtimeKey = 'runtime-b';
    useWorktreeCreationStore.getState().resetForRuntimeSwitch(runtimeKey);
    expect(useWorktreeCreationStore.getState().entries.size).toBe(0);

    finishCreate?.(created());
    const receipt = await pendingRequest;
    expect(receipt.path).toBe('/worktrees/named-tree');
    expect(useWorktreeCreationStore.getState().entries.size).toBe(0);
  });

  test('does not recreate an active task when a bootstrap poll finishes after a runtime switch', async () => {
    let resolvePoll: ((status: GitWorktreeBootstrapStatus) => void) | undefined;
    let pollStarted = false;
    const api = git({
      getGitWorktreeBootstrapStatus: () => {
        pollStarted = true;
        return new Promise<GitWorktreeBootstrapStatus>((resolve) => {
          resolvePoll = resolve;
        });
      },
    });

    const pendingRequest = request({ taskId: 'draft-stale-poll', git: api });
    while (!pollStarted) await new Promise((resolve) => setTimeout(resolve, 0));

    runtimeKey = 'runtime-b';
    useWorktreeCreationStore.getState().resetForRuntimeSwitch(runtimeKey);
    resolvePoll?.(pending('git-ready'));

    await pendingRequest;
    expect(useWorktreeCreationStore.getState().entries.size).toBe(0);
  });

  test('normalizes intent paths when looking up entries', () => {
    const key = getWorktreeCreationKey(intent({ projectRoot: '/repo/', sourceDirectory: '/repo/' }));
    expect(key).toBe(getWorktreeCreationKey(intent()));
  });
});
