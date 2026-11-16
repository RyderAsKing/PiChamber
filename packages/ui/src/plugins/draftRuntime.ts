import { create } from 'zustand';

import { getPiSessionStore, subscribeDraftEvents } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import type { PiComposerControl, PiSessionEvent } from '@/lib/pi/protocol';
import { getTabClientId } from '@/lib/pi/tab-client-id';
import { isPiThinkingLevel } from '@/lib/pi/thinking';
import { fetchPiRuntimeHealth } from '@/lib/pi/transport';
import type { PiModelRef, PiThinkingLevel } from '@/lib/pi/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import type { NewSessionDraftState } from '@/sync/session-ui-types';
import type { ControlValue } from './extensionControls';
import { rememberControls } from './rememberedControls';

/**
 * A draft session: a Pi runtime started for the open new-session draft, before
 * anything is sent, so the folder's extensions can declare their composer
 * controls and run their commands. The daemon keeps it out of listings and
 * marks its events `draft` (see `session-daemon/DOCUMENTATION.md`); this
 * store is the only place they land. Sending adopts it, closing the draft or
 * moving it to another folder discards it, and the daemon's idle lifetime
 * ends an abandoned one. While it starts the composer draws the folder's
 * remembered controls (`rememberedControls.ts`); clicks made before it is
 * ready wait here and run once it is, or on the created session.
 */

export type DraftRuntimeStatus = 'starting' | 'ready' | 'failed' | 'expired';

interface DraftRuntimeEntry {
  draftId: string;
  runtimeKey: string;
  directory: string;
  status: DraftRuntimeStatus;
  sessionId: string | null;
  /** The runtime's controls once it reported them; kept after it expires. */
  controls: PiComposerControl[] | null;
  model: PiModelRef | null;
  thinking: PiThinkingLevel | null;
  /** When the start failed; a new attempt waits `DRAFT_FAILURE_BACKOFF_MS`. */
  failedAt?: number;
  /** The server has no draft sessions: never try again on this runtime. */
  unsupported?: boolean;
  /**
   * The runtime's model was set by an extension and is not one the composer
   * lists: the composer's model and thinking are not pushed to it, and the
   * adopting create sends the draft's own (`ConsumedDraftRuntime`).
   */
  modelUnlisted?: boolean;
  /**
   * A model turn started in this draft's session, which made it an ordinary
   * session (`releasePromoted`). This draft gets no other draft session:
   * whatever started the turn would start one in each.
   */
  turnStarted?: boolean;
}

/** A click made in the draft, waiting for its runtime or already sent there. */
export interface DraftPick {
  value: ControlValue;
  /** Sent to the draft session; it stays shown until the extension reports it. */
  sentAt?: number;
}

interface DraftRuntimeState {
  entry: DraftRuntimeEntry | null;
  /** The open draft's clicks, by control id. */
  picks: { draftId: string; values: Record<string, DraftPick> } | null;
}

export const useDraftRuntimeStore = create<DraftRuntimeState>(() => ({ entry: null, picks: null }));

export const DRAFT_FAILURE_BACKOFF_MS = 30_000;
/** A sent click is shown this long at most before the extension must have confirmed it. */
const PICK_PENDING_MS = 8_000;
/** Model and thinking picks in the draft reach its runtime after this pause. */
const MODEL_PUSH_DELAY_MS = 300;
const MAX_STARTING_BUFFER = 64;
/** How long a pushed model or thinking waits for its echo before a matching event counts as the runtime's own. */
const ECHO_TTL_MS = 5_000;
/** A send waits at most this long for clicks still running on the draft session. */
const PICK_SETTLE_MS = 1_500;

const get = () => useDraftRuntimeStore.getState();
const setEntry = (entry: DraftRuntimeEntry | null) => useDraftRuntimeStore.setState({ entry });
const patchEntry = (patch: Partial<DraftRuntimeEntry>) => {
  const entry = get().entry;
  if (entry) setEntry({ ...entry, ...patch });
};

export interface DraftRuntimeTarget {
  draftId: string;
  directory: string;
}

/**
 * The draft a runtime is started for, or null when none should be: a closed
 * draft, or one whose session does not exist in its folder yet (a worktree or
 * branch to create first) or forks another session. Those show the
 * remembered controls only, and their clicks are applied after create.
 */
export const draftRuntimeTargetOf = (
  draft: Pick<NewSessionDraftState, 'open' | 'id' | 'directoryOverride' | 'worktreeIntent' | 'branchIntent' | 'parentID'> | null | undefined,
  defaultDirectory: string | null | undefined,
): DraftRuntimeTarget | null => {
  if (!draft?.open || !draft.id) return null;
  if (draft.worktreeIntent || draft.branchIntent || draft.parentID) return null;
  const directory = draft.directoryOverride || defaultDirectory;
  return directory ? { draftId: draft.id, directory } : null;
};

/** The folder a draft's session is created in, warmed or not: what its remembered controls are keyed by. */
export const draftDirectoryOf = (
  draft: Pick<NewSessionDraftState, 'directoryOverride'> | null | undefined,
  defaultDirectory: string | null | undefined,
): string | null => draft?.directoryOverride || defaultDirectory || null;

/** Apply one `extension.control` payload: replace in place, add at the end, or remove. */
export const applyControlEvent = (
  controls: readonly PiComposerControl[],
  payload: { control?: PiComposerControl; id?: string; removed?: boolean },
): PiComposerControl[] => {
  if (payload.removed === true && typeof payload.id === 'string') {
    return controls.filter((control) => control.id !== payload.id);
  }
  const control = payload.control;
  if (!control) return [...controls];
  const index = controls.findIndex((candidate) => candidate.id === control.id);
  if (index === -1) return [...controls, control];
  const next = [...controls];
  next[index] = control;
  return next;
};

// Generation of the current start: a start that lands after its draft was
// released or replaced discards what it started.
let generation = 0;
// Draft events for a session not known yet (a start still in flight).
let startingBuffer: PiSessionEvent[] = [];

const discard = (sessionId: string, directory: string, runtimeKey: string) => {
  // Another server's draft ends with its idle lifetime there.
  if (runtimeKey !== getRuntimeKey()) return;
  void piClient.discardDraftSession(sessionId, { directory, runtimeKey }).catch(() => {});
};

const sameModel = (a: PiModelRef | null | undefined, b: PiModelRef | null | undefined) => (
  Boolean(a && b && a.providerId === b.providerId && a.modelId === b.modelId)
);

const composerSelection = (): { model: PiModelRef | null; thinking: PiThinkingLevel | null } => {
  const config = useConfigStore.getState();
  const model = config.currentProviderId && config.currentModelId
    ? { providerId: config.currentProviderId, modelId: config.currentModelId }
    : null;
  return { model, thinking: isPiThinkingLevel(config.currentVariant) ? config.currentVariant : null };
};

// ---------------------------------------------------------------------------
// Model and thinking, both ways
// ---------------------------------------------------------------------------

// The last value this tab sent to the draft runtime whose echo has not come
// back. One slot each, replaced by the next push and ignored once it is
// `ECHO_TTL_MS` old, so an echo that never matches (the runtime clamped the
// thinking level) cannot swallow a later change the runtime makes itself.
interface PendingEcho { key: string; until: number }
let pushedModel: PendingEcho | null = null;
let pushedThinking: PendingEcho | null = null;
const modelKey = (model: PiModelRef) => `${model.providerId}\n${model.modelId}`;
const isEcho = (slot: PendingEcho | null, key: string) => Boolean(slot && slot.key === key && Date.now() < slot.until);
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** The draft session is gone on the daemon (a request named it unknown). */
const isSessionGone = (error: unknown) => (
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'INVALID_SESSION'
);

/** Send the composer's model and thinking to the draft runtime when they differ from its own. */
const pushComposerSelection = () => {
  const entry = get().entry;
  if (!entry || entry.status !== 'ready' || !entry.sessionId) return;
  // An extension chose a model the composer cannot show: pushing the
  // composer's would undo it.
  if (entry.modelUnlisted) return;
  const { model, thinking } = composerSelection();
  const scope = { directory: entry.directory, runtimeKey: entry.runtimeKey };
  const sessionId = entry.sessionId;
  if (model && !sameModel(model, entry.model)) {
    const slot = { key: modelKey(model), until: Date.now() + ECHO_TTL_MS };
    pushedModel = slot;
    patchEntry({ model });
    void piClient.setSessionModel({ sessionId, model }, scope).catch((error) => {
      // The send pushes the composer's model again; nothing is lost.
      if (pushedModel === slot) pushedModel = null;
      if (isSessionGone(error)) restartGoneDraft(sessionId);
    });
  }
  if (thinking && thinking !== entry.thinking) {
    const slot = { key: thinking, until: Date.now() + ECHO_TTL_MS };
    pushedThinking = slot;
    patchEntry({ thinking });
    void piClient.setSessionThinking({ sessionId, thinking }, scope).catch((error) => {
      if (pushedThinking === slot) pushedThinking = null;
      if (isSessionGone(error)) restartGoneDraft(sessionId);
    });
  }
};

const schedulePush = () => {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushComposerSelection();
  }, MODEL_PUSH_DELAY_MS);
};

/** The runtime changed its model on its own (an extension's command): the composer follows. */
const adoptRuntimeModel = (model: PiModelRef) => {
  if (isEcho(pushedModel, modelKey(model))) {
    pushedModel = null;
    patchEntry({ model, modelUnlisted: false });
    return;
  }
  const config = useConfigStore.getState();
  const provider = config.providers.find((entry) => entry.id === model.providerId);
  const listed = Boolean(provider?.models?.some((candidate) => candidate.id === model.modelId));
  // Unlisted: the composer keeps showing its own model, but it must not be
  // pushed back over the extension's choice (see `modelUnlisted`).
  patchEntry({ model, modelUnlisted: !listed });
  if (!listed) return;
  if (config.currentProviderId === model.providerId && config.currentModelId === model.modelId) return;
  if (config.currentProviderId !== model.providerId) config.setProvider(model.providerId);
  useConfigStore.getState().setModel(model.modelId);
  // Pi reports a command's thinking change before its model change, so the
  // thinking may have been skipped as unsupported by the previous model.
  // Take the runtime's thinking now, or the composer would keep (and push
  // back) its own.
  const thinking = get().entry?.thinking;
  const next = useConfigStore.getState();
  if (thinking && next.currentVariant !== thinking && next.getCurrentModelVariants().includes(thinking)) {
    next.setCurrentVariant(thinking);
  }
};

const adoptRuntimeThinking = (thinking: PiThinkingLevel) => {
  patchEntry({ thinking });
  // The daemon reports one level per change: after a push, the next report
  // is its answer, the level asked for or the one the model clamped it to.
  // Either way the slot is spent; a clamped level is adopted.
  const echo = isEcho(pushedThinking, thinking);
  pushedThinking = null;
  if (echo) return;
  const config = useConfigStore.getState();
  if (config.currentVariant === thinking) return;
  if (!config.getCurrentModelVariants().includes(thinking)) return;
  config.setCurrentVariant(thinking);
};

// ---------------------------------------------------------------------------
// Clicks made in the draft
// ---------------------------------------------------------------------------

const setPicks = (draftId: string, values: Record<string, DraftPick>) => {
  useDraftRuntimeStore.setState({ picks: Object.keys(values).length ? { draftId, values } : null });
};

const dropPick = (draftId: string, id: string, only?: DraftPick): boolean => {
  const picks = get().picks;
  if (!picks || picks.draftId !== draftId || !(id in picks.values)) return false;
  // A timer or reply for an older click must not clear a newer one.
  if (only && picks.values[id] !== only) return false;
  const values = { ...picks.values };
  delete values[id];
  setPicks(draftId, values);
  return true;
};

/** The draft's clicks still waiting, by control id. */
const draftPicksFor = (draftId: string | null | undefined): Record<string, DraftPick> => {
  const picks = get().picks;
  return draftId && picks?.draftId === draftId ? picks.values : {};
};

// The last value the user chose for each (non-action) control, kept for the
// whole draft, confirmed or not: a draft session that is started again, or a
// send that could not adopt it, gets them again. Not drawn; `picks` is.
let chosen: { draftId: string; values: Record<string, ControlValue> } | null = null;
const chosenFor = (draftId: string): Record<string, ControlValue> => (chosen?.draftId === draftId ? chosen.values : {});
const choose = (draftId: string, id: string, value: ControlValue) => {
  chosen = { draftId, values: { ...chosenFor(draftId), [id]: value } };
};
/**
 * A click the draft session never confirmed (it failed, or no report came):
 * the composer shows the session's value again, so that is what the draft has.
 */
const unchoose = (draftId: string, id: string) => {
  if (chosen?.draftId !== draftId || !(id in chosen.values)) return;
  const values = { ...chosen.values };
  const entry = get().entry;
  const reported = entry?.draftId === draftId ? entry.controls?.find((candidate) => candidate.id === id) : undefined;
  if (reported && reported.kind !== 'action') values[id] = reported.value;
  else delete values[id];
  chosen = { draftId, values };
};

/** The draft session's clicks become unsent: it is gone and they go to the next one. */
const unsendPicks = () => {
  const picks = get().picks;
  if (!picks || !Object.values(picks.values).some((pick) => pick.sentAt)) return;
  const values: Record<string, DraftPick> = {};
  for (const [id, pick] of Object.entries(picks.values)) values[id] = { value: pick.value };
  setPicks(picks.draftId, values);
};

/** Mark the draft session gone: it is started again when needed, and its clicks resent. */
const expireEntry = () => {
  if (!get().entry) return;
  patchEntry({ status: 'expired', sessionId: null });
  unsendPicks();
};

/**
 * A model turn started in the draft session (a control's command sent a
 * message, or an extension did on its own). The daemon made it an ordinary
 * session at that moment, listed and running, so the draft lets go of it
 * without discarding it. Clicks already sent ran there and are not for the
 * session this draft creates; the rest wait for that session.
 */
const releasePromoted = () => {
  const entry = get().entry;
  if (!entry) return;
  const picks = get().picks;
  if (picks?.draftId === entry.draftId) {
    const kept: Record<string, DraftPick> = {};
    const values = { ...chosenFor(entry.draftId) };
    for (const [id, pick] of Object.entries(picks.values)) {
      if (pick.sentAt) delete values[id];
      else kept[id] = pick;
    }
    if (chosen?.draftId === entry.draftId) chosen = { draftId: entry.draftId, values };
    setPicks(entry.draftId, kept);
  }
  patchEntry({ status: 'failed', sessionId: null, failedAt: undefined, turnStarted: true });
};

/**
 * The daemon disposed the draft session without telling us (a request named
 * it unknown, or a click did not run while the runtime shows another
 * value): start it again and resend the clicks.
 */
let lastRestartAt = 0;
const restartGoneDraft = (sessionId: string) => {
  const entry = get().entry;
  if (!entry || entry.sessionId !== sessionId) return;
  expireEntry();
  // Should it still be there after all (a missed event made its value look
  // different), it must not be left running beside the new one.
  discard(sessionId, entry.directory, entry.runtimeKey);
  // A daemon that keeps dropping new draft sessions gets the failure
  // backoff instead of a restart loop.
  if (Date.now() - lastRestartAt < DRAFT_FAILURE_BACKOFF_MS) {
    patchEntry({ status: 'failed', failedAt: Date.now() });
    return;
  }
  lastRestartAt = Date.now();
  void ensureDraftRuntime({ draftId: entry.draftId, directory: entry.directory });
};

/**
 * Put back, as unsent clicks, chosen values a newly started draft session
 * does not have (the old one expired or failed with them).
 */
const restoreChosenPicks = (draftId: string, controls: readonly PiComposerControl[]) => {
  const values = { ...draftPicksFor(draftId) };
  let changed = false;
  for (const [id, value] of Object.entries(chosenFor(draftId))) {
    if (id in values) continue;
    const control = controls.find((candidate) => candidate.id === id);
    if (!control || control.kind === 'action' || control.value === value) continue;
    values[id] = { value };
    changed = true;
  }
  if (changed) setPicks(draftId, values);
};

/**
 * The live draft session reported its controls again. One it changed on its
 * own is what the draft now has, and one it removed is no longer chosen. One
 * it declares only now (after it started, so `restoreChosenPicks` and a click
 * made on the remembered controls missed it) gets the chosen value as a click.
 */
const followRuntimeControls = (
  draftId: string,
  previous: readonly PiComposerControl[],
  controls: readonly PiComposerControl[],
) => {
  const values = chosenFor(draftId);
  const picks = draftPicksFor(draftId);
  let next: Record<string, ControlValue> | null = null;
  const restored: Record<string, DraftPick> = {};
  for (const [id, value] of Object.entries(values)) {
    if (id in picks) continue;
    const before = previous.some((candidate) => candidate.id === id);
    const control = controls.find((candidate) => candidate.id === id);
    if (!control || control.kind === 'action') {
      if (before) {
        next = { ...(next ?? values) };
        delete next[id];
      }
      continue;
    }
    if (control.value === value) continue;
    if (before) next = { ...(next ?? values), [id]: control.value };
    else restored[id] = { value };
  }
  if (next) chosen = { draftId, values: next };
  if (Object.keys(restored).length === 0) return;
  setPicks(draftId, { ...picks, ...restored });
  sendPicks();
};

// Clicks run one after another: the daemon answers a second command while
// one runs with SESSION_BUSY.
let draining: Promise<void> | null = null;

/** Send the draft's waiting clicks to its ready runtime, one at a time. */
const sendPicks = () => {
  if (draining) return;
  draining = drainPicks().finally(() => {
    draining = null;
    // A click that arrived as the loop ended.
    const { entry, picks } = get();
    if (entry?.status === 'ready' && picks?.draftId === entry.draftId
      && Object.values(picks.values).some((pick) => !pick.sentAt)) sendPicks();
  });
};

const drainPicks = async (): Promise<void> => {
  for (;;) {
    const { entry, picks } = get();
    if (!entry || entry.status !== 'ready' || !entry.sessionId || !picks || picks.draftId !== entry.draftId) return;
    const next = Object.entries(picks.values).find(([, pick]) => !pick.sentAt);
    if (!next) return;
    const [id, pick] = next;
    const { draftId, sessionId } = entry;
    const control = (entry.controls ?? []).find((candidate) => candidate.id === id);
    // Gone from this folder's extensions, or already what was asked for.
    if (!control || (control.kind !== 'action' && control.value === pick.value)) {
      dropPick(draftId, id, pick);
      continue;
    }
    const sent: DraftPick = { ...pick, sentAt: Date.now() };
    setPicks(draftId, { ...picks.values, [id]: sent });
    setTimeout(() => {
      if (dropPick(draftId, id, sent)) unchoose(draftId, id);
    }, PICK_PENDING_MS);
    try {
      const { ran } = await piClient.runExtensionControl(
        { sessionId, id, ...(pick.value !== undefined ? { value: pick.value } : {}), clientId: getTabClientId() },
        { runtimeKey: entry.runtimeKey },
      );
      if (ran && control.kind !== 'action') continue;
      if (!ran && control.kind !== 'action') {
        const now = get().entry;
        const reported = now?.sessionId === sessionId
          ? (now.controls ?? []).find((candidate) => candidate.id === id)
          : undefined;
        // Not run, yet the runtime shows another value: the draft session
        // is gone on the daemon.
        if (reported && reported.kind !== 'action' && reported.value !== pick.value) {
          restartGoneDraft(sessionId);
          return;
        }
      }
      dropPick(draftId, id, sent);
    } catch (error) {
      if (isSessionGone(error)) {
        restartGoneDraft(sessionId);
        return;
      }
      if (dropPick(draftId, id, sent)) unchoose(draftId, id);
      void import('@/components/ui').then(({ toast }) => toast.error(`Could not change ${control.label}`));
    }
  }
};

/** Settle sent clicks the extension has now reported. */
const settlePicks = (controls: readonly PiComposerControl[]) => {
  const picks = get().picks;
  if (!picks) return;
  for (const [id, pick] of Object.entries(picks.values)) {
    if (!pick.sentAt) continue;
    const control = controls.find((candidate) => candidate.id === id);
    if (!control || (control.kind !== 'action' && control.value === pick.value)) dropPick(picks.draftId, id, pick);
  }
};

/**
 * Click a control in the draft. With a ready runtime it runs there at once;
 * otherwise it waits (and is shown) until the runtime is ready or the
 * session is created. An action needs a ready runtime.
 */
export const pickDraftControl = (draftId: string, control: PiComposerControl, value: ControlValue): void => {
  const entry = get().entry;
  const live = entry?.draftId === draftId && entry.status === 'ready' ? entry : null;
  if (control.kind === 'action' && !live) return;
  const current = draftPicksFor(draftId);
  if (current[control.id]?.sentAt) return;
  if (control.kind !== 'action') {
    choose(draftId, control.id, value);
    // Back to the value the live draft session reported: nothing to ask for.
    // A remembered value (before it reported) is no proof: the click is kept.
    const reported = live?.controls?.find((candidate) => candidate.id === control.id);
    if (reported && reported.kind !== 'action' && reported.value === value) {
      dropPick(draftId, control.id);
      return;
    }
  }
  setPicks(draftId, { ...current, [control.id]: { value } });
  if (entry?.draftId === draftId && (entry.status === 'expired' || entry.status === 'failed')) {
    void ensureDraftRuntime({ draftId, directory: entry.directory });
    return;
  }
  sendPicks();
};

/**
 * Wait (at most `PICK_SETTLE_MS`) for the draft's clicks still running on its
 * draft session, so their events land before a send adopts it. Goes on
 * regardless after that.
 */
export const settleDraftPicks = async (draftId: string): Promise<void> => {
  const busy = () => Boolean(draining) || Object.values(draftPicksFor(draftId)).some((pick) => pick.sentAt);
  const entry = get().entry;
  if (!entry || entry.draftId !== draftId || entry.status !== 'ready' || !busy()) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  await new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PICK_SETTLE_MS);
    const check = () => {
      if (!busy()) resolve();
    };
    unsubscribe = useDraftRuntimeStore.subscribe(check);
    void draining?.then(check);
  });
  if (timer) clearTimeout(timer);
  (unsubscribe as (() => void) | null)?.();
};

const sessionControl = (sessionId: string, id: string): PiComposerControl | undefined => {
  const state = getPiSessionStore().getState() as { reducer?: { bySession?: Map<string, { extensionControls?: Map<string, PiComposerControl> }> } };
  return state.reducer?.bySession?.get(sessionId)?.extensionControls?.get(id);
};

/**
 * Run the draft's clicks on the session created from it, one at a time,
 * before its first prompt. When the send adopted the draft session
 * (`adoptedSessionId` is the created id), only clicks that never reached it
 * run. Otherwise (no draft session, or the daemon created a new one because
 * it was gone) every value chosen in the draft runs where the new session
 * reports another. A click that did not run while the session still shows
 * another value counts as not applied and is reported.
 */
export const applyDraftControlPicks = async (
  draftId: string,
  sessionId: string,
  adoptedSessionId: string | null = null,
): Promise<void> => {
  const picks = draftPicksFor(draftId);
  const adopted = adoptedSessionId !== null && adoptedSessionId === sessionId;
  const wanted: Record<string, ControlValue> = adopted ? {} : { ...chosenFor(draftId) };
  for (const [id, pick] of Object.entries(picks)) {
    if (!pick.sentAt || !adopted) wanted[id] = pick.value;
  }
  useDraftRuntimeStore.setState((state) => (state.picks?.draftId === draftId ? { picks: null } : state));
  if (chosen?.draftId === draftId) chosen = null;
  const failed: string[] = [];
  for (const [id, value] of Object.entries(wanted)) {
    const before = sessionControl(sessionId, id);
    if (before && before.kind !== 'action' && before.value === value) continue;
    try {
      const { ran } = await piClient.runExtensionControl(
        { sessionId, id, ...(value !== undefined ? { value } : {}), clientId: getTabClientId() },
        { runtimeKey: getRuntimeKey() },
      );
      if (ran) continue;
      const after = sessionControl(sessionId, id);
      if (after && after.kind !== 'action' && after.value === value) continue;
      failed.push(id);
    } catch {
      failed.push(id);
    }
  }
  if (failed.length === 0) return;
  const { toast } = await import('@/components/ui');
  toast.error(failed.length === 1 ? 'Could not apply a composer control to this session' : 'Could not apply some composer controls to this session');
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const applyDraftEvent = (event: PiSessionEvent) => {
  const entry = get().entry;
  if (!entry || entry.sessionId !== event.sessionId) return;
  switch (event.name) {
    case 'extension.control': {
      const controls = applyControlEvent(entry.controls ?? [], event.payload);
      patchEntry({ controls });
      rememberControls(entry.runtimeKey, entry.directory, controls, { authoritative: true });
      followRuntimeControls(entry.draftId, entry.controls ?? [], controls);
      settlePicks(controls);
      return;
    }
    case 'session.snapshot': {
      const controls = event.payload.snapshot.extensionControls;
      if (!Array.isArray(controls)) return;
      patchEntry({ controls });
      rememberControls(entry.runtimeKey, entry.directory, controls, { authoritative: true });
      followRuntimeControls(entry.draftId, entry.controls ?? [], controls);
      settlePicks(controls);
      return;
    }
    case 'session.model':
      adoptRuntimeModel(event.payload.model);
      return;
    case 'session.thinking':
      adoptRuntimeThinking(event.payload.thinking);
      return;
    case 'session.lifecycle':
      // Busy without a command is a model turn: the daemon's last marked
      // event for this session, which is an ordinary one from here on.
      if (event.payload.state === 'busy' && !event.payload.command) releasePromoted();
      return;
    case 'session.deleted':
      // Idled out (the draft sat unused) or disposed by the daemon: it
      // starts again when needed, with the clicks it had.
      expireEntry();
      return;
    default:
  }
};

let unsubscribeEvents: (() => void) | null = null;
let unsubscribeConfig: (() => void) | null = null;
const ensureSubscribed = () => {
  if (unsubscribeEvents) return;
  unsubscribeEvents = subscribeDraftEvents({
    onEvent: (event) => {
      const entry = get().entry;
      if (entry?.status === 'starting') {
        startingBuffer = [...startingBuffer, event].slice(-MAX_STARTING_BUFFER);
        return;
      }
      applyDraftEvent(event);
    },
    onReset: () => {
      // The daemon restarted or the server changed: the draft session is gone.
      generation += 1;
      startingBuffer = [];
      // A new server or daemon may have draft sessions after all.
      if (get().entry) patchEntry({ unsupported: false });
      expireEntry();
    },
  });
  unsubscribeConfig = useConfigStore.subscribe((state, previous) => {
    if (state.currentProviderId === previous.currentProviderId
      && state.currentModelId === previous.currentModelId
      && state.currentVariant === previous.currentVariant) return;
    const entry = get().entry;
    // A model picked here (not one adopted from the runtime, which is
    // listed and so already cleared the flag) is the user's again.
    if (entry?.modelUnlisted && (state.currentProviderId !== previous.currentProviderId
      || state.currentModelId !== previous.currentModelId)) patchEntry({ modelUnlisted: false });
    if (get().entry?.status === 'ready') schedulePush();
  });
};

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

/** Start the draft's session unless it has one (or is waiting out a failure). */
export const ensureDraftRuntime = async (target: DraftRuntimeTarget): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const current = get().entry;
  if (current && current.draftId === target.draftId && current.directory === target.directory && current.runtimeKey === runtimeKey) {
    if (current.status === 'starting' || current.status === 'ready' || current.unsupported || current.turnStarted) return;
    if (current.status === 'failed' && Date.now() - (current.failedAt ?? 0) < DRAFT_FAILURE_BACKOFF_MS) return;
  }
  if (current?.unsupported && current.runtimeKey === runtimeKey) {
    // This server never has draft sessions; remember that for any draft.
    setEntry({ ...current, draftId: target.draftId, directory: target.directory });
    return;
  }
  releaseDraftRuntime();
  ensureSubscribed();
  const token = ++generation;
  startingBuffer = [];
  const keptControls = current?.draftId === target.draftId && current.directory === target.directory ? current.controls : null;
  setEntry({
    draftId: target.draftId,
    runtimeKey,
    directory: target.directory,
    status: 'starting',
    sessionId: null,
    controls: keptControls,
    model: null,
    thinking: null,
  });
  try {
    const health = await fetchPiRuntimeHealth(undefined, runtimeKey);
    if (token !== generation) return;
    if (health.state !== 'ready') {
      // An unreachable daemon reports no capabilities: that is a failure to
      // retry, not proof the server has no draft sessions.
      patchEntry({ status: 'failed', failedAt: Date.now() });
      return;
    }
    if (!health.capabilities?.includes('sessions.discardDraft')) {
      patchEntry({ status: 'failed', unsupported: true, failedAt: Date.now() });
      return;
    }
    const { model, thinking } = composerSelection();
    const detail = await piClient.createSession({
      cwd: target.directory,
      draft: true,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    }, { directory: target.directory, runtimeKey });
    if (token !== generation) {
      discard(detail.session.id, target.directory, runtimeKey);
      return;
    }
    const controls = Array.isArray(detail.extensionControls) ? detail.extensionControls : [];
    setEntry({
      draftId: target.draftId,
      runtimeKey,
      directory: target.directory,
      status: 'ready',
      sessionId: detail.session.id,
      controls,
      model: detail.session.model ?? null,
      thinking: detail.session.thinking ?? null,
    });
    rememberControls(runtimeKey, target.directory, controls, { authoritative: true });
    // Values chosen on a draft session that expired or failed go to this one.
    restoreChosenPicks(target.draftId, controls);
    const buffered = startingBuffer;
    startingBuffer = [];
    for (const event of buffered) {
      if (event.sessionId === detail.session.id && event.sequence > detail.lastSequence) applyDraftEvent(event);
    }
    // The composer may have changed while it started.
    pushComposerSelection();
    sendPicks();
  } catch {
    if (token === generation) patchEntry({ status: 'failed', failedAt: Date.now() });
  }
};

/** Stop the draft's session: its draft closed, changed, or moved to another folder. */
export function releaseDraftRuntime(): void {
  const entry = get().entry;
  if (!entry) return;
  generation += 1;
  startingBuffer = [];
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  // An unsupported server stays known as such.
  setEntry(entry.unsupported ? { ...entry, status: 'failed' } : null);
  if (entry.sessionId) discard(entry.sessionId, entry.directory, entry.runtimeKey);
}

interface ConsumedDraftRuntime {
  sessionId: string;
  /**
   * Set when an extension chose a model the composer does not list: the
   * draft session's own model and thinking, for the adopting create to send
   * instead of the composer's (the daemon then changes neither). The store
   * fills in a default model when none is sent, so leaving them out would not
   * keep the draft's.
   */
  runtimeSelection: { model: PiModelRef; thinking: PiThinkingLevel | null } | null;
}

/**
 * Hand the draft's ready session to the send that creates the session, which
 * adopts it. Null when there is none for this draft and folder; a start still
 * in flight is dropped, and the send creates a session as usual.
 */
export const consumeDraftRuntime = (draftId: string, directory: string | null | undefined): ConsumedDraftRuntime | null => {
  const entry = get().entry;
  if (!entry || entry.draftId !== draftId) return null;
  if (entry.status !== 'ready' || !entry.sessionId || entry.directory !== directory || entry.runtimeKey !== getRuntimeKey()) {
    releaseDraftRuntime();
    return null;
  }
  generation += 1;
  startingBuffer = [];
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  setEntry(null);
  return {
    sessionId: entry.sessionId,
    runtimeSelection: entry.modelUnlisted && entry.model ? { model: entry.model, thinking: entry.thinking } : null,
  };
};

/** The folder the shared session store creates a draft's session in. */
export const defaultDraftDirectory = (): string | null => getPiSessionStore().getState().directory || null;

/** Test hook: forget everything without touching the server. */
export const resetDraftRuntimeForTests = (): void => {
  generation += 1;
  startingBuffer = [];
  pushedModel = null;
  pushedThinking = null;
  chosen = null;
  draining = null;
  lastRestartAt = 0;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  unsubscribeEvents?.();
  unsubscribeEvents = null;
  unsubscribeConfig?.();
  unsubscribeConfig = null;
  useDraftRuntimeStore.setState({ entry: null, picks: null });
};
