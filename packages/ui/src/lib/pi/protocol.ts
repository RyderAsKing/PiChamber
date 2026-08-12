/**
 * Pi IPC event and command protocol — public /api/pi/ envelope shapes.
 *
 * The browser talks to the PiChamber server, never to the private daemon.
 * The server proxies browser requests onto the daemon's private IPC. The
 * shapes here are the public contract for the `/api/pi/` namespace; the
 * daemon module owns the matching private protocol.
 *
 * The protocol guarantees:
 *
 * - Every session event has a monotonically increasing `sequence`.
 * - `session.snapshot` is the reconnect baseline; it carries `lastSequence`.
 * - Errors are stable codes, never empty success or fabricated idle state.
 * - No credentials, pairing secrets, bearer tokens, or attachment bytes are
 *   ever returned through this protocol.
 *
 * These shapes are intentionally typed as discriminated unions so the
 * consumer can switch on `event` or `command` and trust the payload.
 */

import type {
  PiAttachment,
  PiAssistantMessage,
  PiModel,
  PiModelRef,
  PiProvider,
  PiResource,
  PiSession,
  PiSessionId,
  PiSessionLifecycleState,
  PiSessionSnapshot,
  PiThinkingLevel,
  PiUserMessage,
} from './types';

/** Public PiChamber protocol version. Bumped in lockstep with the daemon. */
export const PI_PUBLIC_PROTOCOL_VERSION = 1 as const;

/** Stable, non-secret error codes returned by the Pi runtime. */
export type PiErrorCode =
  | 'DAEMON_UNAVAILABLE'
  | 'DAEMON_AUTH_FAILED'
  | 'DAEMON_REQUEST_FAILED'
  | 'DAEMON_TIMEOUT'
  | 'DAEMON_PROTOCOL_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_SESSION'
  | 'SESSION_CREATE_CANCELLED'
  | 'INVALID_PROMPT'
  | 'SESSION_BUSY'
  | 'SESSION_NOT_RUNNING'
  | 'INVALID_MODEL'
  | 'SESSION_INTERRUPTED'
  | 'SESSION_TREE_NOT_FOUND'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_AUTH_REQUIRED'
  | 'RESOURCE_NOT_FOUND'
  | 'ATTACHMENT_FAILED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_MISSING'
  | 'DAEMON_ENDPOINT_UNVERIFIED'
  | 'DAEMON_CREDENTIAL_UNAVAILABLE'
  | 'MALFORMED_SESSION_JSONL'
  | 'SESSION_JSONL_UNREADABLE'
  | 'RUNTIME_DISPOSAL_FAILED'
  | 'ARCHIVE_METADATA_INVALID'
  | 'ASSISTANT_ERROR';

/** A stable error object returned in response and event payloads. */
export interface PiError {
  code: PiErrorCode;
  message?: string;
}

// ---------------------------------------------------------------------------
// Runtime health
// ---------------------------------------------------------------------------

/** `GET /api/pi/runtime` response. */
export interface PiRuntimeHealth {
  protocolVersion: number;
  state: 'ready' | 'unavailable';
  /** Capability names the daemon currently advertises. */
  capabilities: string[];
  /** Set when `state === 'unavailable'`. */
  error?: PiError;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface PiSessionListItem {
  session: PiSession;
  /** Last message preview for sidebar display. */
  preview?: string;
  /** Last message timestamp. */
  updatedAt: number;
}

export interface PiSessionListResponse {
  sessions: PiSessionListItem[];
  /** Optional cursor for paginated loading. */
  nextCursor?: string | null;
}

export interface PiSessionCreateInput {
  parentId?: PiSessionId;
  title?: string;
  cwd: string;
  model?: PiModelRef;
  thinking?: PiThinkingLevel;
}

export interface PiSessionDetailResponse {
  session: PiSession;
  messages: PiMessageView[];
  /** Last sequence number the daemon has published for this session. */
  lastSequence: number;
}

/** A message view returned by the API, including part data. */
export interface PiMessageView {
  message: PiUserMessage | PiAssistantMessage;
  parts: PiSessionMessagePart[];
}

export type PiSessionMessagePart =
  | {
      type: 'text';
      id: string;
      index: number;
      text: string;
    }
  | {
      type: 'thinking';
      id: string;
      index: number;
      text: string;
    }
  | {
      type: 'tool';
      id: string;
      index: number;
      toolCallId: string;
      name: string;
      input?: unknown;
      output?: unknown;
      isError?: boolean;
      state: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
      startedAt?: number;
      endedAt?: number;
    }
  | {
      type: 'attachment';
      id: string;
      index: number;
      attachment: PiAttachment;
    };

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

export interface PiPromptInput {
  sessionId: PiSessionId;
  text: string;
  /** Optional client-generated message id so SSE can reconcile in place. */
  messageId?: string;
  /** Model override for the new turn. */
  model?: PiModelRef;
  /** Thinking override for the new turn. */
  thinking?: PiThinkingLevel;
  /** Server-side attachments the user has already uploaded. */
  attachments?: Array<{ id: string }>;
}

export interface PiPromptResult {
  accepted: true;
  /** The id the daemon assigned to the user message. */
  messageId: string;
}

export type PiSteerInput = PiPromptInput;
export type PiFollowUpInput = PiPromptInput;

export interface PiAbortInput {
  sessionId: PiSessionId;
}

export interface PiSetModelInput {
  sessionId: PiSessionId;
  model: PiModelRef;
}

export interface PiSetThinkingInput {
  sessionId: PiSessionId;
  thinking: PiThinkingLevel;
}

export interface PiCompactInput {
  sessionId: PiSessionId;
  /** Optional model override for the compacting turn. */
  model?: PiModelRef;
  thinking?: PiThinkingLevel;
}

export interface PiForkInput {
  sessionId: PiSessionId;
  messageId?: string;
  cwd?: string;
}

export interface PiCloneInput {
  sessionId: PiSessionId;
  cwd?: string;
}

export interface PiRenameInput {
  sessionId: PiSessionId;
  title: string;
}

export interface PiDeleteInput {
  sessionId: PiSessionId;
  /** When true, do not throw on missing sessions. */
  ignoreMissing?: boolean;
}

export interface PiArchiveInput {
  sessionId: PiSessionId;
  /** When true, archive; when false, unarchive (PiChamber-only metadata). */
  archived: boolean;
}

export interface PiSessionTreeNode {
  sessionId: PiSessionId;
  parentId: PiSessionId | null;
  title?: string;
  updatedAt: number;
  children: PiSessionTreeNode[];
}

export interface PiSessionTreeResponse {
  rootId: PiSessionId;
  nodes: PiSessionTreeNode[];
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface PiProviderListResponse {
  providers: PiProvider[];
  /** Default model for new sessions (PiChamber or Pi fallback). */
  default?: PiModelRef;
}

export interface PiProviderStatusResponse {
  providerId: string;
  authenticated: boolean;
  error?: PiError;
}

export interface PiProviderLoginInput {
  providerId: string;
  /** API key submission. The browser POSTs the value once; the server writes
   *  it to Pi's credential store and the browser never sees it again. */
  apiKey?: string;
  /** Optional OAuth / device-code payload. */
  oauth?: {
    code?: string;
    callbackUrl?: string;
  };
}

export interface PiProviderLogoutInput {
  providerId: string;
}

export interface PiProviderSetModelsInput {
  providerId: string;
  models: PiModel[];
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface PiResourceListResponse {
  skills: PiResource[];
  prompts: PiResource[];
  agents: PiResource[];
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface PiAttachmentCreateInput {
  /** Original client filename. Sanitized at the server. */
  filename: string;
  /** Mime type as advertised by the browser. */
  mime: string;
  /** Original bytes, base64 encoded. The server writes the file to temp storage. */
  base64: string;
}

export interface PiAttachmentCreateResponse {
  attachment: PiAttachment;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Discriminator for the public event stream. */
export type PiEventName =
  | 'session.snapshot'
  | 'session.lifecycle'
  | 'assistant.message.start'
  | 'assistant.message.delta'
  | 'assistant.message.end'
  | 'assistant.thinking.delta'
  | 'session.tool.start'
  | 'session.tool.update'
  | 'session.tool.end'
  | 'session.queue'
  | 'session.model'
  | 'session.thinking'
  | 'session.compaction'
  | 'session.error'
  | 'session.interrupted';

/** Common envelope for every public event. */
export interface PiEventEnvelope<TName extends PiEventName, TPayload> {
  protocolVersion: number;
  kind: 'event';
  name: TName;
  sequence: number;
  sessionId: PiSessionId;
  directory: string;
  payload: TPayload;
}

export type PiSessionSnapshotEvent = PiEventEnvelope<
  'session.snapshot',
  {
    snapshot: PiSessionSnapshot;
  }
>;

export type PiSessionLifecycleEvent = PiEventEnvelope<
  'session.lifecycle',
  {
    state: PiSessionLifecycleState;
    attempt?: number;
    next?: number;
    message?: string;
  }
>;

export interface PiMessageStartPayload {
  messageId: string;
  role: 'assistant' | 'user';
  parentId?: string;
  /** When the assistant turn started, in ms epoch. */
  startedAt: number;
  model?: PiModelRef;
  thinkingLevel?: PiThinkingLevel;
}

export interface PiMessageEndPayload {
  messageId: string;
  /** Final text/thinking of the assistant message. */
  text?: string;
  thinking?: string;
  /** Final thinking level the daemon persisted. */
  thinkingLevel?: PiThinkingLevel;
  durationMs?: number;
}

export interface PiAssistantMessageDeltaPayload {
  messageId: string;
  /** Optional part identity when the daemon exposes multiple text parts. */
  partId?: string;
  /** Monotonic delta index within the assistant message. */
  contentIndex: number;
  delta: string;
}

export interface PiAssistantThinkingDeltaPayload {
  messageId: string;
  /** Optional part identity when the daemon exposes multiple thinking parts. */
  partId?: string;
  /** Monotonic delta index within the thinking stream. */
  contentIndex: number;
  delta: string;
}

export type PiAssistantMessageStartEvent = PiEventEnvelope<
  'assistant.message.start',
  PiMessageStartPayload
>;

export type PiAssistantMessageDeltaEvent = PiEventEnvelope<
  'assistant.message.delta',
  PiAssistantMessageDeltaPayload
>;

export type PiAssistantMessageEndEvent = PiEventEnvelope<
  'assistant.message.end',
  PiMessageEndPayload
>;

export type PiAssistantThinkingDeltaEvent = PiEventEnvelope<
  'assistant.thinking.delta',
  PiAssistantThinkingDeltaPayload
>;

export interface PiToolUpdatePayload {
  toolCallId: string;
  partId: string;
  messageId: string;
  name: string;
  state: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export type PiSessionToolStartEvent = PiEventEnvelope<
  'session.tool.start',
  PiToolUpdatePayload
>;

export type PiSessionToolUpdateEvent = PiEventEnvelope<
  'session.tool.update',
  PiToolUpdatePayload
>;

export type PiSessionToolEndEvent = PiEventEnvelope<
  'session.tool.end',
  PiToolUpdatePayload
>;

export type PiSessionQueueEvent = PiEventEnvelope<
  'session.queue',
  {
    steering: number;
    followUp: number;
  }
>;

export type PiSessionModelEvent = PiEventEnvelope<
  'session.model',
  {
    model: PiModelRef;
  }
>;

export type PiSessionThinkingEvent = PiEventEnvelope<
  'session.thinking',
  {
    thinking: PiThinkingLevel;
  }
>;

export type PiSessionCompactionEvent = PiEventEnvelope<
  'session.compaction',
  {
    /** True when the compaction is starting; false when it has completed. */
    running: boolean;
  }
>;

export type PiSessionErrorEvent = PiEventEnvelope<
  'session.error',
  {
    code: PiErrorCode;
    message?: string;
  }
>;

export type PiSessionInterruptedEvent = PiEventEnvelope<
  'session.interrupted',
  {
    reason: 'daemon-restart' | 'daemon-crash' | 'runtime-change' | 'user-abort' | 'unknown';
    /** True when the message is mid-stream at interruption time. */
    streaming: boolean;
  }
>;

/** Discriminated union of every event the public stream can publish. */
export type PiSessionEvent =
  | PiSessionSnapshotEvent
  | PiSessionLifecycleEvent
  | PiAssistantMessageStartEvent
  | PiAssistantMessageDeltaEvent
  | PiAssistantMessageEndEvent
  | PiAssistantThinkingDeltaEvent
  | PiSessionToolStartEvent
  | PiSessionToolUpdateEvent
  | PiSessionToolEndEvent
  | PiSessionQueueEvent
  | PiSessionModelEvent
  | PiSessionThinkingEvent
  | PiSessionCompactionEvent
  | PiSessionErrorEvent
  | PiSessionInterruptedEvent;

// ---------------------------------------------------------------------------
// Snapshot / protocol helpers
// ---------------------------------------------------------------------------

/** A snapshot is also a valid event for code that reduces both. */
export const PI_EVENT_KINDS = [
  'session.snapshot',
  'session.lifecycle',
  'assistant.message.start',
  'assistant.message.delta',
  'assistant.message.end',
  'assistant.thinking.delta',
  'session.tool.start',
  'session.tool.update',
  'session.tool.end',
  'session.queue',
  'session.model',
  'session.thinking',
  'session.compaction',
  'session.error',
  'session.interrupted',
] as const satisfies readonly PiEventName[];

/** Discriminator guard. */
export const isPiEvent = (value: unknown): value is PiSessionEvent => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    protocolVersion?: unknown;
    name?: unknown;
    kind?: unknown;
    sequence?: unknown;
    sessionId?: unknown;
    directory?: unknown;
    payload?: unknown;
  };
  return (
    candidate.protocolVersion === PI_PUBLIC_PROTOCOL_VERSION
    && candidate.kind === 'event'
    && typeof candidate.name === 'string'
    && Number.isSafeInteger(candidate.sequence)
    && (candidate.sequence as number) >= 0
    && typeof candidate.sessionId === 'string'
    && candidate.sessionId.length > 0
    && typeof candidate.directory === 'string'
    && candidate.directory.length > 0
    && Boolean(candidate.payload && typeof candidate.payload === 'object' && !Array.isArray(candidate.payload))
    && (PI_EVENT_KINDS as readonly string[]).includes(candidate.name)
  );
};
