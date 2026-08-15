import {
  applyPiEvent,
  createReducerState,
  hydrateSessionFromDetail,
  projectSession,
  type PiProjectedSession,
  type PiReducerState,
} from '@/lib/pi/event-reducer';
import { bootstrapPiDirectory } from '@/lib/pi/bootstrap';
import { piClient, PiRequestError, type PiClientScope } from '@/lib/pi/client';
import { reconnectPiSession } from '@/lib/pi/reconnect';
import type { PiSessionEvent, PiSessionListItem } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export type PiConnectionState = 'loading' | 'ready' | 'unavailable' | 'error';
export interface PiSessionStoreState {
  directory: string | null;
  sessions: readonly PiSessionListItem[];
  selectedSessionId: PiSessionId | null;
  reducer: PiReducerState;
  connection: PiConnectionState;
  error: PiRequestError | null;
  showArchived: boolean;
}
type Listener = () => void;

const initial = (): PiSessionStoreState => ({ directory: null, sessions: [], selectedSessionId: null, reducer: createReducerState(), connection: 'loading', error: null, showArchived: false });
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
  private unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => this.resetForRuntime());

  getState = () => this.state;
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  dispose = () => { this.generation += 1; this.pendingPreferredSessionId = null; this.stream?.dispose(); this.stream = null; this.unsubscribeRuntime(); this.listeners.clear(); };
  setShowArchived = (showArchived: boolean) => { if (showArchived !== this.state.showArchived) { this.state = { ...this.state, showArchived }; this.emit(); } };
  clearError = () => { if (this.state.error) { this.state = { ...this.state, error: null }; this.emit(); } };
  reportError = (error: unknown) => { this.state = { ...this.state, error: asError(error), connection: 'error' }; this.emit(); };
  clear = () => {
    this.generation += 1;
    this.pendingPreferredSessionId = null;
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
        } catch {}
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
    this.stream?.dispose(); this.stream = null;
    this.state = {
      ...initial(),
      directory,
      selectedSessionId: preferredSessionId ?? null,
      connection: 'loading',
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
    if (sessionDir && sessionDir !== this.state.directory) {
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
        if (detail?.session?.directory && detail.session.directory !== this.state.directory) {
          await this.open(detail.session.directory, sessionId);
          return;
        }
      } catch {}
    }
    if (!this.state.directory || sessionId === this.state.selectedSessionId) return;
    const expected = ++this.generation;
    this.stream?.dispose(); this.stream = null;
    this.state = { ...this.state, selectedSessionId: sessionId, error: null }; this.emit();
    await this.hydrate(sessionId, expected);
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
  async archive(sessionId: string, archived: boolean) { await piClient.archiveSession({ sessionId, archived }, this.scope()); this.state = { ...this.state, sessions: this.state.sessions.map((item) => item.session.id === sessionId ? { ...item, session: { ...item.session, archived } } : item) }; this.emit(); }
  async remove(sessionId: string) { const expected = this.generation; await piClient.deleteSession({ sessionId, ignoreMissing: true }, this.scope()); if (expected !== this.generation) return; const sessions = this.state.sessions.filter((item) => item.session.id !== sessionId); const selectedSessionId = this.state.selectedSessionId === sessionId ? sessions.find((item) => !item.session.archived)?.session.id ?? null : this.state.selectedSessionId; this.state = { ...this.state, sessions, selectedSessionId, reducer: createReducerState() }; this.emit(); if (selectedSessionId) await this.hydrate(selectedSessionId, expected); }
  async fork(sessionId: string) { const detail = await piClient.forkSession({ sessionId }, this.scope()); this.upsertAndHydrate(detail); }
  async clone(sessionId: string) { const detail = await piClient.cloneSession({ sessionId }, this.scope()); this.upsertAndHydrate(detail); }
  async navigate(sessionId: string, messageId: string) { const detail = await piClient.navigateSession(sessionId, messageId, this.scope()); await this.hydrate(sessionId, this.generation, detail); }
  async prompt(sessionId: string, text: string, delivery: 'prompt' | 'steer' | 'followUp', attachments?: Array<{ id: string }>) { const input = { sessionId, text, messageId: `msg_${crypto.randomUUID()}`, ...(attachments?.length ? { attachments } : {}) }; if (delivery === 'steer') return piClient.sendSteer(input, this.scope()); if (delivery === 'followUp') return piClient.sendFollowUp(input, this.scope()); return piClient.sendPrompt(input, this.scope()); }
  abort = (sessionId: string) => piClient.abortSession({ sessionId }, this.scope());
  compact = (sessionId: string) => piClient.compactSession({ sessionId }, this.scope());
  setModel = (sessionId: string, providerId: string, modelId: string) => piClient.setSessionModel({ sessionId, model: { providerId, modelId } }, this.scope());
  setThinking = (sessionId: string, thinking: 'off' | 'low' | 'medium' | 'high' | 'xhigh') => piClient.setSessionThinking({ sessionId, thinking }, this.scope());
  tree = (sessionId: string) => piClient.getSessionTree(sessionId, this.scope());
  providers = () => piClient.listProviders({ runtimeKey: getRuntimeKey() });
  upload = (input: { filename: string; mime: string; base64: string }) => piClient.createAttachment(input, this.scope());
  selected(): PiProjectedSession | null { const id = this.state.selectedSessionId; const session = id ? this.state.reducer.bySession.get(id) : undefined; return session ? projectSession(session) : null; }

  private async hydrate(sessionId: string, expected: number, known?: Awaited<ReturnType<typeof piClient.getSession>>) {
    const sessionDir = this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
    const directory = sessionDir || this.directory(); const runtimeKey = getRuntimeKey(); this.stream?.dispose(); this.stream = null;
    const buffered: PiSessionEvent[] = []; let ready = false;
    const onEvent = (event: PiSessionEvent) => { if (expected !== this.generation) return; if (!ready) buffered.push(event); else this.apply(event); };
    try {
      const bootstrap = await bootstrapPiDirectory({ directory, selectedSessionId: sessionId, runtimeKey, onEvent, onStreamDisconnect: () => void this.reconnect(sessionId, expected, runtimeKey) });
      if (expected !== this.generation) { bootstrap.stream?.dispose(); return; }
      if (bootstrap.phase === 'failed') throw new PiRequestError(bootstrap.errors[0]?.error.code ?? 'DAEMON_UNAVAILABLE');
      const detail = known ?? await piClient.getSession(sessionId, { directory, runtimeKey });
      let reducer = hydrateSessionFromDetail({ session: { id: detail.session.id, directory: detail.session.directory }, lastSequence: detail.lastSequence, messages: detail.messages }).state;
      for (const event of buffered) reducer = applyPiEvent(reducer, event).state;
      ready = true;
      this.stream = bootstrap.stream;
      this.state = { ...this.state, reducer, connection: 'ready', error: null };
      this.emit();
    } catch (error) { if (expected === this.generation) this.reportError(error); }
  }

  private async reconnect(sessionId: string, expected: number, runtimeKey: string) {
    if (this.recovering || expected !== this.generation) return; this.recovering = true; this.stream?.dispose(); this.stream = null;
    try { const result = await reconnectPiSession({ directory: this.directory(), sessionId, runtimeKey, lastKnownSequence: this.state.reducer.lastSequence.get(sessionId), onEvent: (event) => this.apply(event) }); if (expected !== this.generation) { result.stream?.dispose(); return; } if (result.phase === 'ready') { this.stream = result.stream; this.state = { ...this.state, reducer: result.reducerState, connection: 'ready', error: null }; this.emit(); } else this.reportError(new PiRequestError(result.error?.code ?? 'DAEMON_UNAVAILABLE', result.error?.message)); } finally { this.recovering = false; }
  }
  private apply(event: PiSessionEvent) { const result = applyPiEvent(this.state.reducer, event); if (result.didApply) { this.state = { ...this.state, reducer: result.state }; this.emit(); } }
  private async upsertAndHydrate(detail: Awaited<ReturnType<typeof piClient.getSession>>) { const expected = this.generation; this.state = { ...this.state, sessions: [{ session: detail.session, updatedAt: detail.session.updatedAt }, ...this.state.sessions.filter((item) => item.session.id !== detail.session.id)], selectedSessionId: detail.session.id }; this.emit(); await this.hydrate(detail.session.id, expected, detail); }
  private directory() { if (!this.state.directory) throw new PiRequestError('DAEMON_UNAVAILABLE'); return this.state.directory; }
  private scope(): PiClientScope { return { directory: this.directory(), runtimeKey: getRuntimeKey() }; }
  private resetForRuntime() { const directory = this.state.directory; this.generation += 1; this.pendingPreferredSessionId = null; this.stream?.dispose(); this.stream = null; this.state = initial(); this.emit(); if (directory) void this.start({ directory }); }
  private emit() { for (const listener of this.listeners) listener(); }
}
