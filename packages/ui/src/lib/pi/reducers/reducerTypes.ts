import { CowMap } from '../cow-map';
import type {
  PiExtensionAppPayload,
  PiExtensionDialogPayload,
  PiExtensionPanelPayload,
} from '../protocol';
import type {
  PiAttachment,
  PiCompactionInfo,
  PiModelRef,
  PiRetryInfo,
  PiSessionLifecycleState,
  PiSessionId,
  PiThinkingLevel,
  PiUsage,
} from '../types';

export interface PiReducerMessagePart {
  id: string;
  index: number;
  type: 'text' | 'thinking' | 'tool' | 'attachment';
  /** Text content for text/thinking parts (assembled from deltas). */
  text: string;
  /** Set while the part is still accepting deltas. */
  streaming: boolean;
  /** For tool parts. */
  tool?: {
    toolCallId: string;
    name: string;
    input?: unknown;
    output?: unknown;
    /** Error message when the tool ended in an error state. */
    error?: string;
    /** Renderer metadata (edit diffs, truncation notes). */
    metadata?: Record<string, unknown>;
    isError?: boolean;
    state: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
    startedAt?: number;
    endedAt?: number;
  };
  /** For attachment parts. */
  attachment?: PiAttachment;
}

export interface PiReducerMessage {
  id: string;
  sessionId: PiSessionId;
  directory: string;
  role: 'user' | 'assistant' | 'extension';
  /** Extension-role only: the pi customType that authored this item. */
  customType?: string;
  /** Extension-role only: payload of a custom entry (`appendEntry`). */
  data?: unknown;
  /** Extension-role only: details payload of a custom message (`sendMessage`). */
  details?: unknown;
  /** User message that owns this assistant turn. */
  parentId?: string;
  /** Created-at (ms epoch) the reducer keeps for ordering. */
  createdAt: number;
  /** Assistant-only: model & thinking captured at creation time. */
  model?: PiModelRef;
  thinkingLevel?: PiThinkingLevel;
  /** Final assembled text/thinking for assistant messages. */
  text: string;
  thinking: string;
  durationMs?: number;
  /** True while the assistant message is still streaming. */
  streaming: boolean;
  /** Set when the assistant message ended in an interrupted/error state. */
  error?: { code: string; message?: string };
  /** Assistant-only: Pi usage for the producing turn. */
  usage?: PiUsage;
}

export type PiReducerPartMap = CowMap<PiReducerMessagePart>;
export type PiReducerMutationKind = 'part' | 'structure';

export const createReducerPartMap = (
  entries?: Iterable<readonly [string, PiReducerMessagePart]>,
): PiReducerPartMap => (entries ? CowMap.from(entries) : CowMap.empty());

export interface PiReducerSessionState {
  sessionId: PiSessionId;
  directory: string;
  /** Last sequence the reducer has accepted for this session. */
  lastSequence: number;
  /** Authoritative lifecycle phase. */
  lifecycle: PiSessionLifecycleState;
  /** Retry countdown/error context while `lifecycle` is `retry`. */
  retry?: PiRetryInfo;
  /** Latest authoritative compaction progress or outcome. */
  compaction?: PiCompactionInfo;
  /** Active model/thinking the session is using. */
  model?: PiModelRef;
  thinking?: PiThinkingLevel;
  /** Messages keyed by message id, ordered by `createdAt`. */
  messages: Map<string, PiReducerMessage>;
  /** Part order per message id. */
  partOrder: Map<string, string[]>;
  parts: PiReducerPartMap;
  /** Pending tool calls (toolCallId → messageId) so an end event can find its parent. */
  toolsByCallId: Map<string, string>;
  /** Assistant messages that still own live token or tool-continuation work. */
  streamingMessages: Set<string>;
  /** Queue depths at the time of the last `session.queue` event. */
  queue: { steering: number; followUp: number };
  /** Live extension status texts (`ctx.ui.setStatus`). Key → text. */
  extensionStatuses: Map<string, string>;
  /** Live extension widgets (`ctx.ui.setWidget`). Key → lines + placement. */
  extensionWidgets: Map<string, { lines: string[]; placement: 'aboveEditor' | 'belowEditor' }>;
  /** Blocking extension dialogs awaiting a user answer, in arrival order. */
  extensionDialogs: PiExtensionDialogPayload[];
  /** Bounded feed of fire-and-forget extension notifications. */
  extensionNotices: Array<{ id: string; message: string; level: 'info' | 'warning' | 'error'; createdAt: number }>;
  /** Bounded feed of extension runtime errors. */
  extensionErrors: Array<{ id: string; source: string; event?: string; message: string; createdAt: number }>;
  /** Live declarative GUI panels keyed by stable id (latest wins). */
  extensionPanels: Map<string, PiExtensionPanelPayload>;
  /** Registered sandboxed extension app surfaces keyed by appId. */
  extensionApps: Map<string, PiExtensionAppPayload>;
  /** Low-frequency invalidation counters for extension-owned catalogs and labels. */
  extensionCatalogRevision?: number;
  sessionTreeRevision?: number;
  /** Latest live standard-RPC editor replacement, applied once by the composer. */
  extensionEditor?: { text: string; sequence: number };
  /** Session-scoped standard-RPC window/tab title. */
  extensionTitle?: string;
  /**
   * Last message a part-level or structural write touched. Live-tail freeze
   * uses this instead of walking every historical part on each token.
   */
  lastMutatedMessageId?: string;
  lastMutationKind?: PiReducerMutationKind;
}

export interface PiReducerState {
  bySession: Map<PiSessionId, PiReducerSessionState>;
  /** Last sequence per session id; `-1` means "no events yet". */
  lastSequence: Map<PiSessionId, number>;
}

export const createReducerState = (): PiReducerState => ({
  bySession: new Map(),
  lastSequence: new Map(),
});

export interface ApplyEventResult {
  state: PiReducerState;
  /** True when the event was accepted (sequence advanced). */
  didApply: boolean;
  /** The session id the event applied to, when it applied. */
  sessionId?: PiSessionId;
}

export interface PiProjectedMessagePart {
  id: string;
  type: PiReducerMessagePart['type'];
  text: string;
  streaming: boolean;
  tool?: PiReducerMessagePart['tool'];
  attachment?: PiAttachment;
}

export interface PiProjectedMessage {
  id: string;
  role: 'user' | 'assistant' | 'extension';
  parentId?: string;
  /** Extension-role only: pi customType that authored this item. */
  customType?: string;
  /** Extension-role only: custom entry payload. */
  data?: unknown;
  /** Extension-role only: custom message details payload. */
  details?: unknown;
  text: string;
  thinking: string;
  streaming: boolean;
  createdAt: number;
  durationMs?: number;
  error?: { code: string; message?: string };
  model?: PiModelRef;
  thinkingLevel?: PiThinkingLevel;
  usage?: PiUsage;
  parts: PiProjectedMessagePart[];
}

export interface PiProjectedSession {
  sessionId: PiSessionId;
  directory: string;
  lifecycle: PiSessionLifecycleState;
  model?: PiModelRef;
  thinking?: PiThinkingLevel;
  queue: { steering: number; followUp: number };
  messages: PiProjectedMessage[];
}

export interface ProjectSessionPrevious {
  session: PiReducerSessionState;
  projection: PiProjectedSession;
}
