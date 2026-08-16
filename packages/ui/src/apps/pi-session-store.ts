import {
  applyPiEvent,
  createReducerState,
  hydrateSessionFromDetail,
  projectSession,
  aliasSyntheticUserIfPersisted,
  type PiProjectedSession,
  type PiReducerSessionState,
  type PiReducerState,
} from '@/lib/pi/event-reducer';
import { bootstrapPiDirectory } from '@/lib/pi/bootstrap';
import { PiRequestError, piClient, type PiClientScope } from '@/lib/pi/client';
import { reconnectPiSession } from '@/lib/pi/reconnect';
import { PiStreamCadence } from '@/lib/pi/stream-cadence';
import type { PiSessionEvent, PiSessionListItem } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { observeSessionActivityTiming, removeSessionActivityTiming } from '@/sync/session-activity-timing';
import { observeSessionActivityEvent, removeSessionOrdering } from '@/sync/session-ordering';
import { notifySessionTurnComplete } from '@/sync/notification-store';

export type PiConnectionState = 'loading' | 'ready' | 'unavailable' | 'error';
export interface PiSessionStoreState {
  directory: string | null;
  sessions: readonly PiSessionListItem[];
  selectedSessionId: PiSessionId | null;
  reducer: PiReducerState;
  connection: PiConnectionState;
  error: PiRequestError | null;
  showArchived: boolean;
  hydratedSessionIds: ReadonlySet<PiSessionId>;
}
type Listener = () => void;

const initial = (): PiSessionStoreState => ({
  directory: null,
  sessions: [],
  selectedSessionId: null,
  reducer: createReducerState(),
  connection: 'loading',
  error: null,
  showArchived: false,
  hydratedSessionIds: new Set(),
});
const asError = (error: unknown) => error instanceof PiRequestError ? error : new PiRequestError('DAEMON_REQUEST_FAILED', error instanceof Error ? error.message : undefined);

let sharedStore: PiSessionStore | null = null;

export const getPiSessionStore = (): PiSessionStore => {
  sharedStore ??= new PiSessionStore();
  return sharedStore;
};

/** One active Pi project identity. Every async completion is generation- and runtime-guarded. */
export class PiSessionStore {
  private state = initial();
  private listeners = new Set<Listener>();
  private stream: { dispose: () => void } | null = null;
  private generation = 0;
  private recovering = false;
  private pendingPreferredSessionId: PiSessionId | null = null;
  private hydratedSessionIds = new Set<PiSessionId>();
  private activityPhaseById = new Map<PiSessionId, 'active' | 'settled'>();
  private pendingPromptById = new Set<PiSessionId>();
  private promptGenerationById = new Map<PiSessionId, number>();
  private readonly cadence = new PiStreamCadence((events) => this.commitEvents(events));
  private unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => this.resetForRuntime());

  getState = () => this.state;
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  dispose = () => {
    this.generation += 1;
    this.pendingPreferredSessionId = null;
    this.hydratedSessionIds.clear();
    this.activityPhaseById.clear();
    this.pendingPromptById.clear();
    this.promptGenerationById.clear();
    this.cadence.dispose();
    this.stream?.dispose();
    this.stream = null;
    this.unsubscribeRuntime();
    this.listeners.clear();
    this.state = initial();
  };
  setShowArchived = (showArchived: boolean) => { if (showArchived !== this.state.showArchived) { this.state = { ...this.state, showArchived }; this.emit(); } };
  clearError = () => { if (this.state.error) { this.state = { ...this.state, error: null }; this.emit(); } };
  reportError = (error: unknown) => { this.state = { ...this.state, error: asError(error), connection: 'error' }; this.emit(); };
  clear = () => {
    this.generation += 1;
    this.pendingPreferredSessionId = null;
    this.hydratedSessionIds.clear();
    this.activityPhaseById.clear();
    this.pendingPromptById.clear();
    this.promptGenerationById.clear();
    this.cadence.dispose();
    this.stream?.dispose(); this.stream = null;
    this.state = { ...initial(), connection: 'ready' };
    this.emit();
  };

  async start(options: { directory?: string | null; sessionId?: PiSessionId | null } = {}): Promise<void> {
    try {
      const requestedDirectory = typeof options.directory === 'string' && options.directory.trim() ? options.directory : null;
      if (options.sessionId) {
        try {
          const detail = await piClient.getSession(options.sessionId, { directory: requestedDirectory ?? undefined, runtimeKey: getRuntimeKey() });
          if (detail?.session?.directory) {
            await this.open(detail.session.directory, options.sessionId);
            return;
          }
        } catch {
          // Session lookup failed, fall through to directory resolution
        }
      }
      if (requestedDirectory) {
        await this.open(requestedDirectory, options.sessionId);
        return;
      }
      const projects = await piClient.listProjects({ runtimeKey: getRuntimeKey() });
      const directory = projects.projects.find((project) => project.selected)?.directory ?? projects.projects[0]?.directory;
      if (!directory) throw new PiRequestError('DAEMON_UNAVAILABLE');
      await this.open(directory, options.sessionId);
    } catch (error) { this.reportError(error); }
  }

  async open(directory: string, preferredSessionId?: PiSessionId | null): Promise<void> {
    if (directory === this.state.directory && this.state.connection === 'loading') {
      if (preferredSessionId && preferredSessionId !== this.state.selectedSessionId) {
        this.pendingPreferredSessionId = preferredSessionId;
        this.state = { ...this.state, selectedSessionId: preferredSessionId, error: null };
        this.emit();
      }
      return;
    }
    if (directory === this.state.directory && this.state.connection === 'ready') {
      if (preferredSessionId && preferredSessionId !== this.state.selectedSessionId) await this.select(preferredSessionId);
      return;
    }
    const expected = ++this.generation;
    this.pendingPreferredSessionId = preferredSessionId ?? null;
    this.hydratedSessionIds.clear();
    this.activityPhaseById.clear();
    this.pendingPromptById.clear();
    this.promptGenerationById.clear();
    this.cadence.dispose();
    this.stream?.dispose(); this.stream = null;
    this.state = {
      ...this.state,
      directory,
      selectedSessionId: preferredSessionId ?? null,
      connection: 'loading',
      hydratedSessionIds: new Set(),
      reducer: {
        bySession: new Map(this.state.reducer.bySession),
        lastSequence: new Map(this.state.reducer.lastSequence),
      },
    };
    this.emit();
    const runtimeKey = getRuntimeKey();
    try {
      const selected = await piClient.selectProject(directory, { runtimeKey });
      if (expected !== this.generation) return;
      const scope: PiClientScope = { directory: selected.directory, runtimeKey };
      if (selected.directory !== directory) {
        this.state = { ...this.state, directory: selected.directory };
        this.emit();
      }
      const health = await piClient.health(scope);
      if (expected !== this.generation) return;
      if (health.state !== 'ready') throw new PiRequestError(health.error?.code ?? 'DAEMON_UNAVAILABLE', health.error?.message);
      const result = await piClient.listSessions(scope);
      if (expected !== this.generation) return;
      const desiredSessionId = this.pendingPreferredSessionId ?? preferredSessionId;
      let matchedSession = desiredSessionId ? result.sessions.find((item) => item.session.id === desiredSessionId) : undefined;
      if (desiredSessionId && !matchedSession) {
        try {
          const detail = await piClient.getSession(desiredSessionId, { directory, runtimeKey });
          if (detail?.session?.directory && detail.session.directory !== directory) {
            if (expected !== this.generation) return;
            await this.open(detail.session.directory, desiredSessionId);
            return;
          }
          if (detail?.session?.id) {
            result.sessions.unshift({ session: detail.session, updatedAt: detail.session.updatedAt });
            matchedSession = { session: detail.session, updatedAt: detail.session.updatedAt };
          }
        } catch {
          // Fall back to default session if desired session doesn't exist
        }
      }
      const selectedSessionId = matchedSession?.session.id
        ?? result.sessions.find((item) => !item.session.archived)?.session.id
        ?? result.sessions[0]?.session.id
        ?? null;
      this.pendingPreferredSessionId = null;
      this.state = { ...this.state, sessions: result.sessions, selectedSessionId, connection: 'ready' }; this.emit();
      if (selectedSessionId) await this.hydrate(selectedSessionId, expected);
    } catch (error) { if (expected === this.generation) this.reportError(error); }
  }

  async select(sessionId: PiSessionId, targetDirectory?: string): Promise<void> {
    const sessionDir = targetDirectory
      ?? this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
    if (sessionDir && normalizePath(sessionDir) !== normalizePath(this.state.directory)) {
      await this.open(sessionDir, sessionId);
      return;
    }
    if (this.state.connection === 'loading') {
      if (this.state.selectedSessionId === sessionId) {
        return;
      }
      this.pendingPreferredSessionId = sessionId;
      this.state = { ...this.state, selectedSessionId: sessionId, error: null };
      this.emit();
      return;
    }
    const inCurrentSessions = this.state.sessions.some((item) => item.session.id === sessionId);
    if (!inCurrentSessions) {
      try {
        const detail = await piClient.getSession(sessionId, { directory: this.state.directory ?? undefined, runtimeKey: getRuntimeKey() });
        if (detail?.session?.directory && normalizePath(detail.session.directory) !== normalizePath(this.state.directory)) {
          await this.open(detail.session.directory, sessionId);
          return;
        }
      } catch {
        // Ignore session detail lookup error
      }
    }
    if (!this.state.directory) return;
    if (sessionId === this.state.selectedSessionId) {
      if (!this.hydratedSessionIds.has(sessionId)) {
        await this.hydrate(sessionId, this.generation);
      }
      return;
    }
    this.cadence.flush();
    this.state = { ...this.state, selectedSessionId: sessionId, error: null };
    this.emit();
    if (this.stream && this.hydratedSessionIds.has(sessionId)) return;
    await this.hydrate(sessionId, this.generation);
  }

  async create(title?: string, options?: { directory?: string; model?: { providerId: string; modelId: string }; thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' }): Promise<string> {
    const directory = options?.directory || this.directory(); const expected = this.generation;
    // PiChamber defaults are authoritative only when explicitly configured;
    // otherwise Pi's settings/model runtime performs its normal fallback.
    // A settings fetch failure aborts creation rather than silently creating a
    // session with an unknown default selection.
    const settings = await piClient.getSettings({ directory, runtimeKey: getRuntimeKey() });
    const detail = await piClient.createSession({
      cwd: directory,
      ...(title ? { title } : {}),
      ...(options?.model ? { model: options.model } : (settings.pichamber.defaultModel ? { model: settings.pichamber.defaultModel } : {})),
      ...(options?.thinking ? { thinking: options.thinking } : (settings.pichamber.defaultThinking ? { thinking: settings.pichamber.defaultThinking } : {})),
    }, { directory, runtimeKey: getRuntimeKey() });
    if (expected !== this.generation) return detail.session.id;
    this.state = { ...this.state, sessions: [{ session: detail.session, updatedAt: detail.session.updatedAt }, ...this.state.sessions], selectedSessionId: detail.session.id }; this.emit();
    await this.hydrate(detail.session.id, expected, detail);
    return detail.session.id;
  }

  async rename(sessionId: string, title: string) { await piClient.renameSession({ sessionId, title }, this.scope()); this.state = { ...this.state, sessions: this.state.sessions.map((item) => item.session.id === sessionId ? { ...item, session: { ...item.session, title } } : item) }; this.emit(); }
  async archive(sessionId: string, archived: boolean) {
    const sessionDir = this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
    await piClient.archiveSession({ sessionId, archived }, this.scope(sessionDir));
    this.state = { ...this.state, sessions: this.state.sessions.map((item) => item.session.id === sessionId ? { ...item, session: { ...item.session, archived } } : item) };
    this.emit();
  }
  async remove(sessionId: string) {
    const expected = this.generation;
    await piClient.deleteSession({ sessionId, ignoreMissing: true }, this.scope());
    if (expected !== this.generation) return;
    removeSessionActivityTiming(sessionId);
    removeSessionOrdering(sessionId);
    const sessions = this.state.sessions.filter((item) => item.session.id !== sessionId);
    const selectedSessionId = this.state.selectedSessionId === sessionId ? sessions.find((item) => !item.session.archived)?.session.id ?? null : this.state.selectedSessionId;
    const nextBySession = new Map(this.state.reducer.bySession);
    nextBySession.delete(sessionId);
    const nextLastSequence = new Map(this.state.reducer.lastSequence);
    nextLastSequence.delete(sessionId);
    this.hydratedSessionIds.delete(sessionId);
    this.activityPhaseById.delete(sessionId);
    this.pendingPromptById.delete(sessionId);
    this.promptGenerationById.delete(sessionId);
    this.state = {
      ...this.state,
      sessions,
      selectedSessionId,
      hydratedSessionIds: new Set(this.hydratedSessionIds),
      reducer: { bySession: nextBySession, lastSequence: nextLastSequence },
    };
    this.emit();
    if (selectedSessionId && selectedSessionId !== this.state.selectedSessionId) await this.hydrate(selectedSessionId, expected);
  }
  async fork(sessionId: string) { const detail = await piClient.forkSession({ sessionId }, this.scope()); this.upsertAndHydrate(detail); }
  async clone(sessionId: string) { const detail = await piClient.cloneSession({ sessionId }, this.scope()); this.upsertAndHydrate(detail); }
  async navigate(sessionId: string, messageId: string) { const detail = await piClient.navigateSession(sessionId, messageId, this.scope()); await this.hydrate(sessionId, this.generation, detail); }
  async prompt(sessionId: string, text: string, delivery: 'prompt' | 'steer' | 'followUp', attachments?: Array<{ id: string }>) {
    const existing = this.state.reducer.bySession.get(sessionId);
    const nextSession: PiReducerSessionState = existing
      ? { ...existing, lifecycle: 'busy' }
      : {
          sessionId,
          directory: this.state.directory
            ?? this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory
            ?? '',
          lastSequence: this.state.reducer.lastSequence.get(sessionId) ?? -1,
          lifecycle: 'busy',
          messages: new Map(),
          partOrder: new Map(),
          parts: new Map(),
          toolsByCallId: new Map(),
          streamingMessages: new Set(),
          queue: { steering: 0, followUp: 0 },
        };
    const nextBySession = new Map(this.state.reducer.bySession);
    nextBySession.set(sessionId, nextSession);
    this.state = { ...this.state, reducer: { ...this.state.reducer, bySession: nextBySession } };
    const generation = (this.promptGenerationById.get(sessionId) ?? 0) + 1;
    this.promptGenerationById.set(sessionId, generation);
    this.pendingPromptById.add(sessionId);
    this.promoteSession(sessionId, 'active');
    this.touchSessionList(sessionId);
    this.emit();
    const input = { sessionId, text, messageId: `msg_${crypto.randomUUID()}`, ...(attachments?.length ? { attachments } : {}) };
    try {
      if (delivery === 'steer') return await piClient.sendSteer(input, this.scope());
      if (delivery === 'followUp') return await piClient.sendFollowUp(input, this.scope());
      return await piClient.sendPrompt(input, this.scope());
    } catch (error) {
      if (this.promptGenerationById.get(sessionId) === generation) {
        this.pendingPromptById.delete(sessionId);
        const current = this.state.reducer.bySession.get(sessionId);
        if (current?.lifecycle === 'busy' && current.streamingMessages.size === 0) {
          const reverted = new Map(this.state.reducer.bySession);
          reverted.set(sessionId, { ...current, lifecycle: 'error' });
          this.state = { ...this.state, reducer: { ...this.state.reducer, bySession: reverted } };
          this.promoteSession(sessionId, 'settled');
          this.emit();
        }
      }
      throw error;
    }
  }
  abort = (sessionId: string) => piClient.abortSession({ sessionId }, this.scope());
  compact = (sessionId: string) => piClient.compactSession({ sessionId }, this.scope());
  setModel = (sessionId: string, providerId: string, modelId: string) => piClient.setSessionModel({ sessionId, model: { providerId, modelId } }, this.scope());
  setThinking = (sessionId: string, thinking: 'off' | 'low' | 'medium' | 'high' | 'xhigh') => piClient.setSessionThinking({ sessionId, thinking }, this.scope());
  tree = (sessionId: string) => piClient.getSessionTree(sessionId, this.scope());
  providers = () => piClient.listProviders({ runtimeKey: getRuntimeKey() });
  upload = (input: { filename: string; mime: string; base64: string }) => piClient.createAttachment(input, this.scope());
  selected(): PiProjectedSession | null { const id = this.state.selectedSessionId; const session = id ? this.state.reducer.bySession.get(id) : undefined; return session ? projectSession(session) : null; }

  private sessionFromDetail(detail: Awaited<ReturnType<typeof piClient.getSession>>) {
    return hydrateSessionFromDetail({
      session: { id: detail.session.id, directory: detail.session.directory },
      lastSequence: detail.lastSequence,
      messages: detail.messages,
    }).session;
  }

  private mergeHydratedSession(
    fetched: PiReducerSessionState,
    existing: PiReducerSessionState | undefined,
  ): PiReducerSessionState {
    if (!existing) return fetched;
    if (existing.sessionId !== fetched.sessionId) return fetched;
    const liveTurn = existing.lifecycle === 'busy' || existing.lifecycle === 'retry';
    if (existing.messages.size === 0 && !liveTurn) return fetched;

    // Fetched fills in history the live reducer does not have. Existing wins on
    // overlapping ids so a stale getSession cannot blank a transcript the user
    // is already looking at — including when they send mid-hydrate.
    const session: PiReducerSessionState = {
      ...fetched,
      lifecycle: liveTurn ? existing.lifecycle : fetched.lifecycle,
      lastSequence: Math.max(fetched.lastSequence, existing.lastSequence),
      messages: new Map(fetched.messages),
      partOrder: new Map(fetched.partOrder),
      parts: new Map(fetched.parts),
      toolsByCallId: new Map(fetched.toolsByCallId),
      streamingMessages: new Set(liveTurn ? existing.streamingMessages : fetched.streamingMessages),
      queue: existing.queue.steering > 0 || existing.queue.followUp > 0 ? existing.queue : fetched.queue,
      ...(existing.model ? { model: existing.model } : {}),
      ...(existing.thinking ? { thinking: existing.thinking } : {}),
    };
    for (const [id, message] of existing.messages) {
      aliasSyntheticUserIfPersisted(session, id, message);
    }
    for (const [id, order] of existing.partOrder) {
      session.partOrder.set(id, order);
      for (const partId of order) {
        const part = existing.parts.get(partId);
        if (part) session.parts.set(partId, part);
      }
    }
    if (liveTurn) {
      for (const [callId, messageId] of existing.toolsByCallId) session.toolsByCallId.set(callId, messageId);
    }
    return session;
  }

  private commitHydratedSession(hydratedSession: PiReducerSessionState, buffered: readonly PiSessionEvent[] = []) {
    this.cadence.flush();
    const existingSession = this.state.reducer.bySession.get(hydratedSession.sessionId);
    const session = this.mergeHydratedSession(hydratedSession, existingSession);
    if (session.lifecycle === 'busy' || session.lifecycle === 'retry') {
      observeSessionActivityTiming(session.sessionId, 'active');
    }
    let reducer: PiReducerState = {
      bySession: new Map(this.state.reducer.bySession),
      lastSequence: new Map(this.state.reducer.lastSequence),
    };
    reducer.bySession.set(session.sessionId, session);
    reducer.lastSequence.set(session.sessionId, session.lastSequence);
    for (const event of buffered) {
      const result = applyPiEvent(reducer, event);
      reducer = result.state;
      if (result.didApply) this.observeActivity(event);
    }
    this.hydratedSessionIds.add(session.sessionId);
    this.state = {
      ...this.state,
      reducer,
      connection: 'ready',
      error: null,
      hydratedSessionIds: new Set(this.hydratedSessionIds),
    };
    this.emit();
  }

  private async hydrate(sessionId: string, expected: number, known?: Awaited<ReturnType<typeof piClient.getSession>>) {
    if (expected !== this.generation) return;
    const sessionDir = this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
    const directory = sessionDir || this.directory();
    const runtimeKey = getRuntimeKey();
    if (this.stream && this.hydratedSessionIds.has(sessionId) && !known) {
      if (this.state.connection !== 'ready' || this.state.error) {
        this.state = { ...this.state, connection: 'ready', error: null };
        this.emit();
      }
      return;
    }
    try {
      if (this.stream) {
        const detail = known ?? await piClient.getSession(sessionId, { directory, runtimeKey });
        if (expected !== this.generation) return;
        if (detail.session.id !== sessionId) return;
        this.commitHydratedSession(this.sessionFromDetail(detail));
        return;
      }
      const buffered: PiSessionEvent[] = [];
      let ready = false;
      const onEvent = (event: PiSessionEvent) => {
        if (expected !== this.generation) return;
        if (!ready) buffered.push(event);
        else this.apply(event);
      };
      const bootstrap = await bootstrapPiDirectory({
        directory,
        selectedSessionId: sessionId,
        runtimeKey,
        onEvent,
        onStreamDisconnect: () => void this.reconnect(this.state.selectedSessionId ?? sessionId, expected, runtimeKey),
      });
      if (expected !== this.generation) {
        bootstrap.stream?.dispose();
        return;
      }
      let hydratedSession = known
        ? this.sessionFromDetail(known)
        : bootstrap.reducerState.bySession.get(sessionId);
      if (!hydratedSession) {
        const detail = known ?? await piClient.getSession(sessionId, { directory, runtimeKey });
        if (expected !== this.generation) {
          bootstrap.stream?.dispose();
          return;
        }
        hydratedSession = this.sessionFromDetail(detail);
      }
      if (hydratedSession.sessionId !== sessionId) {
        bootstrap.stream?.dispose();
        return;
      }
      this.stream = bootstrap.stream;
      this.commitHydratedSession(hydratedSession, buffered);
      ready = true;
    } catch (error) { if (expected === this.generation) this.reportError(error); }
  }

  private async reconnect(sessionId: string, expected: number, runtimeKey: string) {
    if (this.recovering || expected !== this.generation) return; this.recovering = true; this.cadence.flush(); this.stream?.dispose(); this.stream = null;
    try {
      const result = await reconnectPiSession({
        directory: this.directory(),
        sessionId,
        runtimeKey,
        lastKnownSequence: this.streamCursor(),
        onEvent: (event) => this.apply(event),
      });
      if (expected !== this.generation) { result.stream?.dispose(); return; }
      if (result.phase === 'ready') {
        this.stream = result.stream;
        const reducer: PiReducerState = {
          bySession: new Map(this.state.reducer.bySession),
          lastSequence: new Map(this.state.reducer.lastSequence),
        };
        for (const [sId, sState] of result.reducerState.bySession.entries()) {
          const merged = this.mergeHydratedSession(sState, reducer.bySession.get(sId));
          reducer.bySession.set(sId, merged);
          reducer.lastSequence.set(sId, merged.lastSequence);
        }
        for (const sId of result.reducerState.bySession.keys()) this.hydratedSessionIds.add(sId);
        this.state = {
          ...this.state,
          reducer,
          connection: 'ready',
          error: null,
          hydratedSessionIds: new Set(this.hydratedSessionIds),
        };
        this.emit();
      } else this.reportError(new PiRequestError(result.error?.code ?? 'DAEMON_UNAVAILABLE', result.error?.message));
    } finally { this.recovering = false; }
  }
  private apply(event: PiSessionEvent) {
    this.cadence.push(event);
  }

  private observeActivity(event: PiSessionEvent) {
    if (event.name === 'session.lifecycle') {
      const isRunning = event.payload.state === 'busy' || event.payload.state === 'retry';
      this.promoteSession(event.sessionId, isRunning ? 'active' : 'settled', { notifyIfSettled: true });
    } else if (event.name === 'session.snapshot') {
      const isRunning = Boolean(event.payload.snapshot.isStreaming);
      this.promoteSession(event.sessionId, isRunning ? 'active' : 'settled');
    } else if (event.name === 'assistant.message.start') {
      this.promoteSession(event.sessionId, 'active');
    } else if (event.name === 'session.interrupted' || event.name === 'session.error') {
      this.promoteSession(event.sessionId, 'settled', { notifyIfSettled: true });
    }
  }

  private notePromptProgress(event: PiSessionEvent) {
    if (
      event.name === 'assistant.message.start'
      || (event.name === 'session.lifecycle' && (event.payload.state === 'busy' || event.payload.state === 'retry'))
    ) {
      this.pendingPromptById.delete(event.sessionId);
      return;
    }
    if (
      event.name === 'session.error'
      || event.name === 'session.interrupted'
      || (event.name === 'session.lifecycle' && event.payload.state !== 'busy' && event.payload.state !== 'retry')
    ) {
      this.pendingPromptById.delete(event.sessionId);
    }
  }

  private retainPendingPrompt(working: PiReducerState, sessionId: PiSessionId): PiReducerState {
    if (!this.pendingPromptById.has(sessionId)) return working;
    const session = working.bySession.get(sessionId);
    if (!session || session.lifecycle === 'busy' || session.lifecycle === 'retry') return working;
    const bySession = new Map(working.bySession);
    bySession.set(sessionId, { ...session, lifecycle: 'busy' });
    return { ...working, bySession };
  }

  private promoteSession(
    sessionId: PiSessionId,
    phase: 'active' | 'settled',
    options?: { notifyIfSettled?: boolean },
  ) {
    const previous = this.activityPhaseById.get(sessionId);
    this.activityPhaseById.set(sessionId, phase);
    observeSessionActivityTiming(sessionId, phase);
    observeSessionActivityEvent(sessionId, phase);
    if (
      phase === 'settled'
      && options?.notifyIfSettled
      && previous === 'active'
      && this.state.selectedSessionId !== sessionId
    ) {
      notifySessionTurnComplete(sessionId, this.state.directory ?? undefined);
    }
  }

  private touchSessionList(sessionId: PiSessionId) {
    const index = this.state.sessions.findIndex((item) => item.session.id === sessionId);
    if (index < 0) return;
    const now = Date.now();
    const current = this.state.sessions[index];
    if (!current) return;
    const next = this.state.sessions.slice();
    next.splice(index, 1);
    next.unshift({
      ...current,
      updatedAt: now,
      session: { ...current.session, updatedAt: now },
    });
    this.state = { ...this.state, sessions: next };
  }

  private commitEvents(events: readonly PiSessionEvent[]) {
    if (events.length === 0) return;
    let working = this.state.reducer;
    let applied = false;
    for (const event of events) {
      const result = applyPiEvent(working, event);
      working = result.state;
      if (!result.didApply) continue;
      applied = true;
      this.notePromptProgress(event);
      if (
        this.pendingPromptById.has(event.sessionId)
        && event.name === 'session.snapshot'
        && !event.payload.snapshot.isStreaming
      ) {
        working = this.retainPendingPrompt(working, event.sessionId);
        this.promoteSession(event.sessionId, 'active');
        continue;
      }
      this.observeActivity(event);
    }
    if (!applied) return;
    this.state = { ...this.state, reducer: working };
    this.emit();
  }
  private async upsertAndHydrate(detail: Awaited<ReturnType<typeof piClient.getSession>>) { const expected = this.generation; this.state = { ...this.state, sessions: [{ session: detail.session, updatedAt: detail.session.updatedAt }, ...this.state.sessions.filter((item) => item.session.id !== detail.session.id)], selectedSessionId: detail.session.id }; this.emit(); await this.hydrate(detail.session.id, expected, detail); }
  private directory() { if (!this.state.directory) throw new PiRequestError('DAEMON_UNAVAILABLE'); return this.state.directory; }
  private streamCursor(): number | undefined {
    let max = -1;
    for (const sequence of this.state.reducer.lastSequence.values()) {
      if (sequence > max) max = sequence;
    }
    return max >= 0 ? max : undefined;
  }
  private scope(customDirectory?: string): PiClientScope { return { directory: customDirectory || this.directory(), runtimeKey: getRuntimeKey() }; }
  private resetForRuntime() {
    const directory = this.state.directory;
    this.generation += 1;
    this.pendingPreferredSessionId = null;
    this.hydratedSessionIds.clear();
    this.activityPhaseById.clear();
    this.pendingPromptById.clear();
    this.promptGenerationById.clear();
    this.cadence.dispose();
    this.stream?.dispose();
    this.stream = null;
    this.state = initial();
    this.emit();
    if (directory) void this.start({ directory });
  }
  private emit() { for (const listener of this.listeners) listener(); }
}
