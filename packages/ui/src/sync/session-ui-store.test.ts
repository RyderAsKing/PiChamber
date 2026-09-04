import { afterEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import {
  draftBranchCheckoutReceiptMatches,
  materializeOpenDraftSession,
  routeMessage,
  useSessionUIStore,
} from './session-ui-store';
import { clearAllRevertNavigations, setRevertNavigation } from './revert-navigation-store';
import { isNewSessionDraftSendPending } from './session-ui-draft-helpers';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

const store = getPiSessionStore();
const originalCreateSession = useSessionUIStore.getState().createSession;
const originals = {
  upload: store.upload,
  uploadFile: store.uploadFile,
  deleteUpload: store.deleteUpload,
  prompt: store.prompt,
  setModel: store.setModel,
  setThinking: store.setThinking,
  fork: store.fork,
  navigate: store.navigate,
};

afterEach(() => {
  store.upload = originals.upload;
  store.uploadFile = originals.uploadFile;
  store.deleteUpload = originals.deleteUpload;
  store.prompt = originals.prompt;
  store.setModel = originals.setModel;
  store.setThinking = originals.setThinking;
  store.fork = originals.fork;
  store.navigate = originals.navigate;
  useSessionUIStore.setState({
    createSession: originalCreateSession,
    currentSessionId: null,
    currentSessionDirectory: null,
    sendingNewSessionDraftId: null,
    newSessionDraft: {
      id: null,
      open: false,
      directoryOverride: null,
      parentID: null,
    },
  });
  clearAllRevertNavigations();
});

describe('routeMessage', () => {
  test('uploads attached files and forwards their opaque ids with the prompt', async () => {
    const uploads: Array<{ filename: string; mime: string; base64: string }> = [];
    const prompts: unknown[][] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.uploadFile = async (file, input) => {
      uploads.push({ filename: input.filename, mime: input.mime, base64: Buffer.from(await file.arrayBuffer()).toString('base64') });
      return { id: `attachment-${uploads.length}`, name: input.filename, mime: input.mime, size: file.size, expiresAt: Date.now() + 60_000 };
    };
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-1' };
    };

    await routeMessage({
      sessionId: 'session-1',
      directory: '/workspace',
      content: 'hello',
      providerID: 'provider',
      modelID: 'model',
      files: [{ type: 'file', mime: 'image/png', filename: '../screen.png', url: 'data:image/png;base64,AQID' }],
    });

    expect(uploads).toEqual([{ filename: '__screen.png', mime: 'image/png', base64: 'AQID' }]);
    expect(prompts).toEqual([['session-1', 'hello', 'prompt', [{ id: 'attachment-1' }]]]);
  });

  test('deletes compatibility refreshes when prompt dispatch fails', async () => {
    const deleted: string[] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.uploadFile = async (file, input) => ({
      id: 'refreshed-1', name: input.filename, mime: input.mime, size: file.size, expiresAt: Date.now() + 60_000,
    });
    store.deleteUpload = async (id) => { deleted.push(id); };
    store.prompt = async () => { throw new Error('prompt failed'); };

    await expect(routeMessage({
      sessionId: 'session-legacy', directory: '/workspace', content: 'hello', providerID: 'provider', modelID: 'model',
      files: [{ type: 'file', mime: 'text/plain', filename: 'legacy.txt', url: 'data:text/plain;base64,aGVsbG8=' }],
    })).rejects.toThrow('prompt failed');
    expect(deleted).toEqual(['refreshed-1']);
  });

  test('forwards ready attachment ids without uploading again', async () => {
    const prompts: unknown[][] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.upload = async () => { throw new Error('ready attachments must not upload again'); };
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-ready' };
    };

    await routeMessage({
      sessionId: 'session-ready',
      directory: '/workspace',
      content: 'hello',
      providerID: 'provider',
      modelID: 'model',
      files: [{
        type: 'file', mime: 'text/plain', filename: 'note.txt', url: 'data:text/plain;base64,aGVsbG8=',
        uploadState: { status: 'ready', attachmentId: 'opaque-1', expiresAt: Date.now() + 60_000 },
      }],
    });

    expect(prompts).toEqual([['session-ready', 'hello', 'prompt', [{ id: 'opaque-1' }]]]);
  });

  test('rejects pending and failed attachments before prompt dispatch', async () => {
    let prompted = false;
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.prompt = async () => {
      prompted = true;
      return { accepted: true, messageId: 'message-never' };
    };
    const base = {
      sessionId: 'session-1', directory: '/workspace', content: 'hello', providerID: 'provider', modelID: 'model',
    };

    await expect(routeMessage({ ...base, files: [{ type: 'file', mime: 'text/plain', filename: 'a', url: '', uploadState: { status: 'uploading', progress: 10 } }] })).rejects.toThrow('still uploading');
    await expect(routeMessage({ ...base, files: [{ type: 'file', mime: 'text/plain', filename: 'a', url: '', uploadState: { status: 'failed', error: 'nope' } }] })).rejects.toThrow('Retry or remove');
    expect(prompted).toBe(false);
  });

  test('filters out non-data/server file references without throwing base64 errors', async () => {
    const uploads: Array<{ filename: string; mime: string; base64: string }> = [];
    const prompts: unknown[][] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.upload = async (input) => {
      uploads.push(input);
      return { id: `attachment-${uploads.length}`, name: input.filename, mime: input.mime, size: 3 };
    };
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-2' };
    };

    await routeMessage({
      sessionId: 'session-2',
      directory: '/workspace',
      content: 'How hard will it be for us to update @PiChamber/ entirely with this kind of UI: https://github.com/zeronsh/comet',
      providerID: 'provider',
      modelID: 'model',
      files: [{ type: 'file', mime: 'text/plain', filename: 'PiChamber', url: 'file:///workspace/PiChamber' }],
    });

    expect(uploads).toEqual([]);
    expect(prompts).toEqual([['session-2', 'How hard will it be for us to update @PiChamber/ entirely with this kind of UI: https://github.com/zeronsh/comet', 'prompt', undefined]]);
  });

  test('commits model then thinking before prompting', async () => {
    const calls: string[] = [];
    store.setModel = async () => { calls.push('setModel'); };
    store.setThinking = async () => { calls.push('setThinking'); };
    store.upload = async () => ({ id: 'attachment-1', name: 'x', mime: 'text/plain', size: 1 });
    store.prompt = async () => {
      calls.push('prompt');
      return { accepted: true, messageId: 'message-3' };
    };

    await routeMessage({
      sessionId: 'session-3',
      directory: '/workspace',
      content: 'hello',
      providerID: 'opencode-go',
      modelID: 'muse-spark-1.2-contributor',
      variant: 'xhigh',
    });

    expect(calls).toEqual(['setModel', 'setThinking', 'prompt']);
  });

  test('does not prompt when setThinking fails', async () => {
    const prompts: unknown[][] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => {
      throw new Error('thinking rejected');
    };
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-4' };
    };

    await expect(routeMessage({
      sessionId: 'session-4',
      directory: '/workspace',
      content: 'hello',
      providerID: 'provider',
      modelID: 'model',
      variant: 'high',
    })).rejects.toThrow('thinking rejected');
    expect(prompts).toEqual([]);
  });

  test('does not prompt when setModel fails', async () => {
    const prompts: unknown[][] = [];
    const thinkingCalls: unknown[][] = [];
    store.setModel = async () => {
      throw new Error('model rejected');
    };
    store.setThinking = async (...args) => {
      thinkingCalls.push(args);
    };
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-5' };
    };

    await expect(routeMessage({
      sessionId: 'session-5',
      directory: '/workspace',
      content: 'hello',
      providerID: 'provider',
      modelID: 'model',
      variant: 'high',
    })).rejects.toThrow('model rejected');
    expect(thinkingCalls).toEqual([]);
    expect(prompts).toEqual([]);
  });

  test('forkFromMessage calls the backend even when the session catalog has no row and waits for it to resolve', async () => {
    const calls: Array<[string, string | undefined]> = [];
    let resolveFork!: () => void;
    store.fork = (async (sessionId: string, messageId?: string) => {
      calls.push([sessionId, messageId]);
      await new Promise<void>((resolve) => { resolveFork = resolve; });
    }) as typeof store.fork;

    let settled = false;
    const pending = useSessionUIStore.getState().forkFromMessage('temporarily-absent-session', 'live-message-id');
    void pending.then(() => { settled = true; });
    await Promise.resolve();

    expect(calls).toEqual([['temporarily-absent-session', 'live-message-id']]);
    expect(settled).toBe(false);

    resolveFork();
    await pending;
    expect(settled).toBe(true);
  });

  test('forkFromMessage rejects when the backend rejects', async () => {
    const failure = new Error('Invalid entry ID for forking');
    store.fork = (async () => { throw failure; }) as typeof store.fork;

    await expect(useSessionUIStore.getState().forkFromMessage('session-1', 'live-message-id')).rejects.toThrow(failure.message);
  });

  test('restore rejects when Pi cannot navigate to the original leaf', async () => {
    setRevertNavigation('session-1', {
      targetEntryId: 'reverted-entry',
      previousLeafId: 'original-leaf',
      newLeafId: 'short-leaf',
    }, []);
    const failure = new Error('Restore target not found');
    store.navigate = (async () => { throw failure; }) as typeof store.navigate;

    await expect(useSessionUIStore.getState().handleSlashRedo('session-1')).rejects.toThrow(failure.message);
  });

  test('matches branch checkout receipts only to the exact runtime, directory, and branch', () => {
    const intent = { runtimeKey: 'runtime-a', directory: '/workspace/project', branch: 'feature/a' };

    expect(draftBranchCheckoutReceiptMatches(intent, { ...intent })).toBe(true);
    expect(draftBranchCheckoutReceiptMatches(intent, { ...intent, runtimeKey: 'runtime-b' })).toBe(false);
    expect(draftBranchCheckoutReceiptMatches(intent, { ...intent, directory: '/workspace/other' })).toBe(false);
    expect(draftBranchCheckoutReceiptMatches(intent, { ...intent, branch: 'main' })).toBe(false);
    expect(draftBranchCheckoutReceiptMatches(intent, null)).toBe(false);
  });

  test('setNewSessionDraftTarget preserves draft open state and updates target project/directory', () => {
    useProjectsStore.setState({
      projects: [
        { id: 'proj-1', path: '/workspace/proj-1', label: 'Proj 1', addedAt: 1, lastOpenedAt: 1 },
        { id: 'proj-2', path: '/workspace/proj-2', label: 'Proj 2', addedAt: 2, lastOpenedAt: 2 },
      ],
      activeProjectId: 'proj-1',
    });

    const { openNewSessionDraft, setNewSessionDraftTarget } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
    });

    const stateAfterOpen = useSessionUIStore.getState();
    expect(stateAfterOpen.newSessionDraft.open).toBe(true);
    expect(stateAfterOpen.newSessionDraft.selectedProjectId).toBe('proj-1');
    expect(stateAfterOpen.currentSessionId).toBe(null);

    setNewSessionDraftTarget({
      projectId: 'proj-2',
      directoryOverride: '/workspace/proj-2',
    });

    const stateAfterTargetChange = useSessionUIStore.getState();
    expect(stateAfterTargetChange.newSessionDraft.open).toBe(true);
    expect(stateAfterTargetChange.newSessionDraft.selectedProjectId).toBe('proj-2');
    expect(stateAfterTargetChange.newSessionDraft.directoryOverride).toBe('/workspace/proj-2');
    expect(stateAfterTargetChange.currentSessionId).toBe(null);
  });

  test('refuses to materialize a draft with an unconfirmed branch intent', async () => {
    const { openNewSessionDraft } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
      branchIntent: {
        runtimeKey: getRuntimeKey(),
        directory: '/workspace/proj-1',
        branch: 'feature/a',
      },
    });

    await expect(materializeOpenDraftSession({
      providerID: 'provider',
      modelID: 'model',
    })).rejects.toThrow('Confirm the selected branch');
  });

  test('refuses to materialize a draft with an uncreated worktree intent', async () => {
    const { openNewSessionDraft } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
      worktreeIntent: {
        runtimeKey: getRuntimeKey(),
        projectRoot: '/workspace/proj-1',
        sourceDirectory: '/workspace/proj-1',
        startRef: 'main',
      },
    });

    await expect(materializeOpenDraftSession({
      providerID: 'provider',
      modelID: 'model',
    })).rejects.toThrow('Create the selected worktree');
  });

  test('does not derive a new session title from an extension command', async () => {
    const titles: Array<string | undefined> = [];
    useSessionUIStore.getState().setCurrentSession('session-other', '/workspace/other');
    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
    });
    useSessionUIStore.setState({
      createSession: async (title, directoryOverride) => {
        titles.push(title);
        return { id: 'session-extension', directory: directoryOverride ?? '/workspace/proj-1' };
      },
    });

    await materializeOpenDraftSession({
      providerID: 'provider',
      modelID: 'model',
      initialPrompt: '/balance',
      initialInputKind: 'extension-command',
    });

    expect(titles).toEqual([undefined]);
  });

  test('routes a completed worktree draft to its created session after navigation', async () => {
    const prompts: unknown[][] = [];
    const creationMetadata: Array<Record<string, unknown> | undefined> = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-1' };
    };

    const worktreeIntent = {
      runtimeKey: getRuntimeKey(),
      projectRoot: '/workspace/proj-1',
      sourceDirectory: '/workspace/proj-1',
      startRef: 'main',
    };
    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
      worktreeIntent,
    });
    const draftSnapshot = useSessionUIStore.getState().newSessionDraft;

    useSessionUIStore.getState().setCurrentSession('session-other', '/workspace/other');
    useSessionUIStore.setState({
      createSession: async (_title, directoryOverride, _parentId, metadata) => {
        creationMetadata.push(metadata);
        return {
          id: 'session-worktree',
          directory: directoryOverride ?? '/worktrees/new',
        };
      },
    });

    await useSessionUIStore.getState().sendMessage(
      'initial worktree prompt',
      'provider',
      'model',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        worktreeCreationReceipt: {
          ...worktreeIntent,
          path: '/worktrees/new',
          branch: 'pichamber/new',
        },
        draftSnapshot,
      },
    );

    expect(creationMetadata).toEqual([{
      model: { providerId: 'provider', modelId: 'model' },
      thinking: undefined,
      select: false,
    }]);
    expect(prompts).toEqual([[
      'session-worktree',
      'initial worktree prompt',
      'prompt',
      undefined,
      { knownEmptyTranscript: true },
    ]]);
    expect(useSessionUIStore.getState().currentSessionId).toBe('session-other');
  });

  test('stores a worktree intent and clears it when the draft directory changes', () => {
    const { openNewSessionDraft, setNewSessionDraftTarget } = useSessionUIStore.getState();
    openNewSessionDraft({ selectedProjectId: 'proj-1', directoryOverride: '/workspace/proj-1' });
    setNewSessionDraftTarget({
      branchIntent: null,
      worktreeIntent: {
        runtimeKey: getRuntimeKey(),
        projectRoot: '/workspace/proj-1',
        sourceDirectory: '/workspace/proj-1',
        startRef: 'main',
      },
    });
    expect(useSessionUIStore.getState().newSessionDraft.worktreeIntent?.startRef).toBe('main');

    setNewSessionDraftTarget({ directoryOverride: '/workspace/proj-2' });
    expect(useSessionUIStore.getState().newSessionDraft.worktreeIntent).toBeNull();
  });

  test('stores a branch intent and clears it when the draft directory changes', () => {
    const { openNewSessionDraft, setNewSessionDraftTarget } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
    });

    setNewSessionDraftTarget({
      branchIntent: {
        runtimeKey: getRuntimeKey(),
        directory: '/workspace/proj-1',
        branch: 'feature/a',
      },
    });
    const draftWithBranch = useSessionUIStore.getState().newSessionDraft;
    expect(draftWithBranch.open).toBe(true);
    expect(draftWithBranch.branchIntent).toEqual({
      runtimeKey: getRuntimeKey(),
      directory: '/workspace/proj-1',
      branch: 'feature/a',
    });

    setNewSessionDraftTarget({ directoryOverride: '/workspace/proj-2' });
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.branchIntent).toBeNull();
  });
});

describe('sendingNewSessionDraftId', () => {
  test('tracks only the draft that owns the in-flight send', () => {
    const { openNewSessionDraft, setSendingNewSessionDraftId } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
    });
    const draftId = useSessionUIStore.getState().newSessionDraft.id;

    expect(draftId).not.toBeNull();
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBeNull();
    setSendingNewSessionDraftId(draftId);
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBe(draftId);
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe(null);
    expect(isNewSessionDraftSendPending(
      useSessionUIStore.getState().newSessionDraft,
      useSessionUIStore.getState().currentSessionId,
      useSessionUIStore.getState().sendingNewSessionDraftId,
    )).toBe(true);

    useSessionUIStore.getState().setCurrentSession('session-other', '/workspace/other');
    openNewSessionDraft({ directoryOverride: '/workspace/proj-1' });
    expect(useSessionUIStore.getState().newSessionDraft.id).not.toBe(draftId);
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBe(draftId);
    expect(isNewSessionDraftSendPending(
      useSessionUIStore.getState().newSessionDraft,
      useSessionUIStore.getState().currentSessionId,
      useSessionUIStore.getState().sendingNewSessionDraftId,
    )).toBe(false);
  });

  test('restoreForRuntimeSwitch clears a stale in-flight owner', () => {
    useSessionUIStore.getState().setSendingNewSessionDraftId('draft-old');
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBe('draft-old');
    useSessionUIStore.getState().restoreForRuntimeSwitch();
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBeNull();
  });
});
