/**
 * Pi-native session and message data shapes.
 *
 * These PiChamber-owned types mirror the public Pi protocol contract: every
 * session-scoped record carries the session id, events are sequenced, and
 * daemon-side identities are Pi session ids.
 *
 * The data model deliberately keeps a small, stable surface:
 *
 * - `PiSession` is what projects/sidebar/message-load code reads.
 * - `PiMessage` and `PiMessagePart` are the unit of streaming; deltas assemble
 *   into finalized messages once the daemon publishes `assistant.message.end`.
 * - `PiAssistantMessage` and `PiUserMessage` keep the metadata Pi persists.
 * - `PiSnapshot` is the reconnect baseline; it carries the last sequence so
 *   the UI knows it has no events to apply yet.
 *
 * The shapes are consumed directly by the Pi bootstrap and event reducers.
 */

/**
 * Stable Pi session identity. Pi persists a unique `sessionId` per agent
 * session; the directory is the canonical workspace that owns the session.
 */
export type PiSessionId = string;

/** A normalized directory that owns a Pi session. */
export type PiDirectory = string;

/**
 * The PiChamber-side `PiSession` record. We keep the original Pi name fields
 * and add the PiChamber-visible directory + model selection so the sidebar and
 * message loaders can index without re-querying the daemon.
 */
export interface PiSession {
  id: PiSessionId;
  /** Canonical directory the session belongs to (server-confirmed). */
  directory: PiDirectory;
  title?: string;
  parentId?: PiSessionId | null;
  createdAt: number;
  updatedAt: number;
  /**
   * The last model/thinking used inside this session. Hydration prefers the
   * latest assistant turn so reopening an older chat does not inherit the
   * globally last-selected model. After the user changes model or thinking
   * here, that choice stays until they change it again.
   */
  model?: PiModelRef;
  thinking?: PiThinkingLevel;
  /**
   * The Pi `agent` is preserved for reference; PiChamber does not expose it
   * as a user-facing agent selector.
   */
  agent?: string;
  /** When the session is hidden from the PiChamber sidebar without modifying Pi JSONL. */
  archived?: boolean;
  /** Last archived timestamp (ms epoch). Matches the workstream-0 archive contract. */
  timeArchived?: number;
  /** Total message count from the most recent authoritative snapshot. */
  messageCount?: number;
}

/** A reference to a model the user can pick in PiChamber. */
export interface PiModelRef {
  providerId: string;
  modelId: string;
}

/** Pi thinking levels; PiChamber does not introduce a new vocabulary. */
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Common message envelope. Use a discriminant in UI code that switches on role. */
export type PiMessage = PiUserMessage | PiAssistantMessage;

interface PiMessageBase {
  id: string;
  sessionId: PiSessionId;
  directory: PiDirectory;
  createdAt: number;
  /** Optional parent message when this message is the result of a fork/clone. */
  parentId?: string | null;
}

export interface PiUserMessage extends PiMessageBase {
  role: 'user';
  text: string;
  /**
   * Server-local attachment paths. The base64 inline attachment model is
   * removed; PiChamber writes a temp file on the server and gives the path to
   * Pi. The `id` is the temporary-file id; the `name` is the original client
   * filename (sanitized at the server).
   */
  attachments?: PiAttachment[];
}

export interface PiAssistantMessage extends PiMessageBase {
  role: 'assistant';
  text: string;
  thinking: string;
  /**
   * The Pi model that produced this message. After a model change this
   * becomes the message's model, even if the user later picks a different
   * default for new sessions.
   */
  model?: PiModelRef;
  thinkingLevel?: PiThinkingLevel;
  /** Wall-clock duration of the producing turn in milliseconds. */
  durationMs?: number;
  /**
   * `error` is set when the assistant message ended in an interruption
   * (daemon crash, runtime change, explicit `session.interrupted`).
   */
  error?: PiAssistantError;
  /** True while the assistant is still streaming this message. */
  streaming?: boolean;
  /**
   * Pi-native usage for the producing turn. Pi persists a `Usage` object on
   * every assistant message; PiChamber sanitizes (numbers only, finite, ≥ 0)
   * and projects it unchanged. Pi has no separate reasoning-token field —
   * thinking is a content block, so any "reasoning" token tile stays `—`.
   */
  usage?: PiUsage;
}

/**
 * PiChamber-owned `PiUsage` record. Numbers are coerced to finite, non-negative
 * values at the daemon boundary; the public protocol never carries floating
 * point, NaN, or unknown keys. Decimal costs are accepted but the public tile
 * rounds to the nearest cent (or fourth decimal for sub-cent values).
 */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface PiAssistantError {
  code: string;
  message?: string;
}

/** Server-local attachment metadata written by PiChamber from a browser upload. */
export interface PiAttachment {
  /** Server-side temp-file id (used to look up the path on the server). */
  id: string;
  /** Original client-side filename, sanitized. */
  name: string;
  /** Resolved mime type, normalized to `text/plain` when applicable. */
  mime: string;
  /** Local size in bytes after sanitization. */
  size: number;
  /**
   * Server-local absolute path. Browsers never receive this value through
   * `getMessage`; the daemon hands it only to Pi tools.
   */
  path?: string;
}

/**
 * Message parts. Pi streams deltas with `contentIndex` against the running
 * message; the reducer assembles those into a finalized `text`/`thinking`
 * value when the daemon publishes `assistant.message.end`.
 */
export type PiMessagePart = PiTextPart | PiThinkingPart | PiToolPart | PiAttachmentPart;

export type PiPartId = string;

interface PiPartBase {
  id: PiPartId;
  messageId: string;
  sessionId: PiSessionId;
  /** Order within a message. Pi preserves monotonic per-message order. */
  index: number;
  createdAt: number;
}

export interface PiTextPart extends PiPartBase {
  type: 'text';
  text: string;
  /**
   * True while the daemon is still streaming text. Becomes `false` after
   * `assistant.message.end`. UI components can key off this for streaming
   * animations; they should not treat it as authoritative.
   */
  streaming?: boolean;
}

export interface PiThinkingPart extends PiPartBase {
  type: 'thinking';
  text: string;
  streaming?: boolean;
}

export interface PiToolPart extends PiPartBase {
  type: 'tool';
  toolCallId: string;
  name: string;
  /**
   * `input` is the JSON arguments passed to the tool. The shape is tool-specific.
   */
  input?: unknown;
  output?: unknown;
  /** Set to true when the tool returned an error. */
  isError?: boolean;
  /** Tool execution state from Pi. */
  state: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
  startedAt?: number;
  endedAt?: number;
}

export interface PiAttachmentPart extends PiPartBase {
  type: 'attachment';
  attachment: PiAttachment;
}

/**
 * A snapshot of a single session's live state at a point in time. Snapshots
 * are the reconnect baseline: a client connects, receives a `session.snapshot`
 * event, and resumes deltas after the snapshot's `lastSequence`.
 */
export interface PiRetryInfo {
  attempt?: number;
  next?: number;
  message?: string;
}

export type PiCompactionReason = 'manual' | 'threshold' | 'overflow';
export type PiCompactionPhase = 'running' | 'retrying' | 'completed' | 'failed' | 'aborted';

export interface PiCompactionInfo {
  phase: PiCompactionPhase;
  reason?: PiCompactionReason;
  startedAt?: number;
  completedAt?: number;
  attempt?: number;
  maxAttempts?: number;
  next?: number;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  willRetry?: boolean;
  message?: string;
}

export interface PiSessionSnapshot {
  sessionId: PiSessionId;
  directory: PiDirectory;
  /**
   * Last sequence number the daemon has published for this session at the
   * time the snapshot was taken. Clients use it as the reconnect watermark.
   */
  lastSequence: number;
  /** True while the assistant turn is still running. */
  isStreaming: boolean;
  /** Pi queue depths; the reducer exposes them in the UI sidebar status. */
  queue?: { steering: number; followUp: number };
  /** The active model/thinking for this session at snapshot time. */
  model?: PiModelRef;
  thinking?: PiThinkingLevel;
  /** Last finalized assistant text/thinking at snapshot time. */
  lastText?: string;
  lastThinking?: string;
  /** Last finalized tool part (if any) at snapshot time. */
  lastToolPart?: PiToolPart;
  /** The current session lifecycle phase. */
  lifecycle: PiSessionLifecycleState;
  /** Retry countdown/error context while `lifecycle` is `retry`. */
  retry?: PiRetryInfo;
  /** Latest active or completed compaction state. */
  compaction?: PiCompactionInfo;
  /** Server authoritative run start for an active turn. */
  runStartedAt?: number;
  /** Server wall clock at snapshot time. */
  serverNow?: number;
}

export type PiSessionLifecycleState =
  | 'idle'
  | 'busy'
  | 'retry'
  | 'error'
  | 'interrupted';

/**
 * Provider metadata returned by `GET /api/pi/providers`. Status is reported
 * as a string code so credentials are never returned to the browser.
 */
export interface PiProvider {
  id: string;
  label: string;
  /** Whether the provider currently has working credentials. */
  authenticated: boolean;
  /** Optional human-readable error code describing why a provider is unavailable. */
  error?: { code: string; message?: string };
  models: PiModel[];
}

export interface PiModel {
  id: string;
  providerId: string;
  label?: string;
  contextWindow?: number;
  /** Model supports reasoning output. */
  supportsThinking?: boolean;
  /** Allowed thinking levels for this model. */
  thinkingLevels?: PiThinkingLevel[];
}

/**
 * Pi resource (skill, prompt template, AGENTS.md scope). The UI lists these
 * via `GET /api/pi/resources`. PiChamber does not write a separate copy of
 * these on disk; the SDK reads them through Pi's normal discovery.
 */
export interface PiResource {
  /** Opaque daemon identifier; it never encodes a server filesystem path. */
  id: string;
  kind: 'skill' | 'prompt' | 'agents';
  name: string;
  description?: string;
  /** Where Pi found this resource. */
  location: 'global' | 'project' | 'package' | 'path';
  /** True only when the Pi-owned source can be safely edited through the daemon. */
  editable?: boolean;
  /** Body for prompt templates or applicable instruction files. */
  content?: string;
}
