import React from 'react';

import type { PiComposerControl } from '@/lib/pi/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  DRAFT_FAILURE_BACKOFF_MS,
  defaultDraftDirectory,
  draftDirectoryOf,
  draftRuntimeTargetOf,
  ensureDraftRuntime,
  releaseDraftRuntime,
  useDraftRuntimeStore,
  type DraftPick,
  type DraftRuntimeStatus,
} from './draftRuntime';
import { readRememberedControls } from './rememberedControls';

/**
 * React side of the draft session (`draftRuntime.ts`): start it while a
 * new-session draft is open, stop it when the draft closes or moves, and
 * the controls the draft's composer draws.
 */

let releaseWatcherInstalled = false;
/** Stop the draft's session as soon as its draft closes, changes, or moves to another folder. */
const installReleaseWatcher = () => {
  if (releaseWatcherInstalled) return;
  releaseWatcherInstalled = true;
  useSessionUIStore.subscribe((state) => {
    const { entry, picks } = useDraftRuntimeStore.getState();
    const draft = state.newSessionDraft;
    const openId = draft?.open ? draft.id : null;
    if (picks && picks.draftId !== openId) useDraftRuntimeStore.setState({ picks: null });
    if (!entry || entry.unsupported) return;
    const target = draftRuntimeTargetOf(draft, defaultDraftDirectory());
    if (!target || target.draftId !== entry.draftId || target.directory !== entry.directory) releaseDraftRuntime();
  });
};

/**
 * Start a draft session for the open new-session draft. Mounted by the
 * composer; it does nothing while a session is open or the draft's first
 * send is on its way (that send adopts the draft session).
 */
export function useDraftRuntime(): void {
  installReleaseWatcher();
  const draft = useSessionUIStore((state) => state.newSessionDraft);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sendingDraftId = useSessionUIStore((state) => state.sendingNewSessionDraftId);
  const defaultDirectory = usePiSessionSnapshot((state) => state.directory || null, undefined, 'chrome');
  const status = useDraftRuntimeStore((state) => state.entry?.status ?? null);
  const target = currentSessionId ? null : draftRuntimeTargetOf(draft, defaultDirectory);
  const sending = Boolean(target && sendingDraftId === target.draftId);
  const draftId = target?.draftId ?? null;
  const directory = target?.directory ?? null;

  React.useEffect(() => {
    if (!draftId || !directory || sending) return;
    void ensureDraftRuntime({ draftId, directory });
  }, [directory, draftId, sending]);

  // One that idled out, or failed, comes back when the window does.
  React.useEffect(() => {
    if (!draftId || !directory || sending || (status !== 'expired' && status !== 'failed')) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const revive = () => {
      if (document.visibilityState !== 'hidden') void ensureDraftRuntime({ draftId, directory });
    };
    document.addEventListener('visibilitychange', revive);
    window.addEventListener('focus', revive);
    // A failed start is also retried once its backoff is over, focus or not.
    // (An expired one waits for the window or a click: restarting it at
    // once would keep an unused draft session alive forever. One the
    // daemon dropped under a click restarts from `draftRuntime.ts`.)
    const failedAt = status === 'failed' ? useDraftRuntimeStore.getState().entry?.failedAt : undefined;
    const retry = failedAt !== undefined
      ? setTimeout(revive, Math.max(0, failedAt + DRAFT_FAILURE_BACKOFF_MS - Date.now()) + 50)
      : null;
    return () => {
      if (retry) clearTimeout(retry);
      document.removeEventListener('visibilitychange', revive);
      window.removeEventListener('focus', revive);
    };
  }, [directory, draftId, sending, status]);
}

export interface DraftComposerControls {
  controls: PiComposerControl[];
  /** `remembered` until the draft's runtime reported its own. */
  source: 'runtime' | 'remembered';
  status: DraftRuntimeStatus | null;
  picks: Record<string, DraftPick>;
}

const NO_CONTROLS: PiComposerControl[] = [];
const NO_PICKS: Record<string, DraftPick> = {};

/**
 * What the draft's composer draws: its runtime's controls once reported
 * (kept while it restarts), else what this folder's extensions last
 * declared, with the draft's waiting clicks.
 */
export function useDraftComposerControls(draftId: string | null): DraftComposerControls {
  const draft = useSessionUIStore((state) => state.newSessionDraft);
  const defaultDirectory = usePiSessionSnapshot((state) => state.directory || null, undefined, 'chrome');
  const entry = useDraftRuntimeStore((state) => state.entry);
  const picksState = useDraftRuntimeStore((state) => state.picks);
  const directory = draftId && draft?.open && draft.id === draftId ? draftDirectoryOf(draft, defaultDirectory) : null;
  const runtimeKey = getRuntimeKey();
  const own = entry && entry.draftId === draftId && entry.directory === directory && entry.runtimeKey === runtimeKey
    ? entry
    : null;
  const ownControls = own?.controls ?? null;
  const remembered = React.useMemo(
    () => (ownControls || !directory ? NO_CONTROLS : readRememberedControls(runtimeKey, directory)),
    [directory, ownControls, runtimeKey],
  );
  const picks = draftId && picksState?.draftId === draftId ? picksState.values : NO_PICKS;
  return {
    controls: ownControls ?? remembered,
    source: ownControls ? 'runtime' : 'remembered',
    status: own?.status ?? null,
    picks,
  };
}
