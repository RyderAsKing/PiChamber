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
 * - Every session event has a monotonically increasing global `sequence`.
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
  PiRetryInfo,
  PiSession,
  PiSessionId,
  PiSessionLifecycleState,
  PiSessionSnapshot,
  PiThinkingLevel,
  PiUsage,
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
  | 'PROJECT_UNTRUSTED'
  | 'PI_SETTINGS_INVALID'
  | 'PI_MODEL_CONFIG_INVALID'
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
// Projects
// ---------------------------------------------------------------------------

export interface PiProject {
  directory: string;
  selected: boolean;
}

export interface PiProjectListResponse {
  projects: PiProject[];
}

export interface PiProjectSelectResponse {
  directory: string;
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
  /** True while the daemon still has an in-flight assistant turn. */
  isStreaming: boolean;
  /** Authoritative lifecycle at getSession time. Idle is not proof the stream is dead. */
  lifecycle: PiSessionLifecycleState;
  /** Retry countdown/error context while `lifecycle` is `retry`. */
  retry?: PiRetryInfo;
  /** Server authoritative run start for an active turn. Present only while busy/retry. */
  runStartedAt?: number;
  /** Server wall clock at the time the response was generated. */
  serverNow?: number;
}

/** Metadata returned after a successful tree navigation. */
export interface PiNavigationMeta {
  targetEntryId: string;
  previousLeafId: string | null;
  newLeafId: string | null;
  editorText?: string;
}

export interface PiSessionNavigateResponse extends PiSessionDetailResponse {
  navigation: PiNavigationMeta;
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
  /** Pi history entry identity accepted by `sessions.navigate`. */
  entryId: string;
  parentId: string | null;
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
  type: 'api_key' | 'oauth';
  /** API key submission. The browser POSTs the value once; the server writes
   * it through Pi's credential runtime and never returns it. */
  apiKey?: string;
}

export interface PiProviderLoginState {
  id: string;
  providerId: string;
  state: 'pending' | 'complete' | 'failed';
  prompt?: {
    type: 'text' | 'secret' | 'select' | 'manual_code';
    message?: string;
    placeholder?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
  };
  authUrl?: { url: string; instructions?: string };
  deviceCode?: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number };
  error?: PiError;
}

export interface PiProviderLoginResponse {
  login: PiProviderLoginState;
}

export interface PiProviderLogoutInput {
  providerId: string;
}

export interface PiProviderModelsConfig {
  providerId: string;
  label: string;
  baseUrl: string;
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
  models: PiModel[];
}

export interface PiProviderConfigResponse {
  config: PiProviderModelsConfig | null;
}

export interface PiProviderSetModelsInput extends PiProviderModelsConfig {
  /** Optional non-secret Pi models.json environment reference, e.g. `{env:API_KEY}`. */
  apiKeyReference?: string;
  /** Optional per-provider headers. Values are write-only and never returned. */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Pi settings
// ---------------------------------------------------------------------------

export type PiConfigThinkingLevel = PiThinkingLevel;

export interface PiSettingsSnapshot {
  pi: {
    global: { defaultProvider?: string; defaultModel?: string; defaultThinking?: PiConfigThinkingLevel; defaultProjectTrust?: 'ask' | 'always' | 'never' };
    project: { trusted: boolean; denied?: boolean; requiresTrust?: boolean; defaultProvider?: string; defaultModel?: string; defaultThinking?: PiConfigThinkingLevel };
  };
  pichamber: {
    version: 1;
    defaultModel?: PiModelRef;
    defaultThinking?: PiThinkingLevel;
    defaultThinkingByModel?: Record<string, PiThinkingLevel>;
    smallModel?: PiModelRef;
    walkthroughModel?: PiModelRef;
    defaultRetryLimit?: number;
  };
}

export interface PiSettingsUpdateInput {
  scope: 'global' | 'project';
  defaultModel?: PiModelRef | null;
  defaultThinking?: PiConfigThinkingLevel | null;
  trust?: boolean | null;
}

export interface PiChamberDefaultsUpdateInput {
  defaultModel?: PiModelRef | null;
  defaultThinking?: PiThinkingLevel | null;
  /** Per-model thinking. `null` clears the map; a per-key `null` deletes that model. */
  defaultThinkingByModel?: Record<string, PiThinkingLevel | null> | null;
  smallModel?: PiModelRef | null;
  walkthroughModel?: PiModelRef | null;
  defaultRetryLimit?: number | null;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface PiResourceListResponse {
  skills: PiResource[];
  prompts: PiResource[];
  agents: PiResource[];
}

export interface PiResourceUpdateInput {
  resourceId: string;
  content: string;
}

export interface PiPromptTemplateCreateInput {
  name: string;
  description: string;
  content: string;
  location: 'global' | 'project';
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
  | 'session.updated'
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
  { state: PiSessionLifecycleState; runStartedAt?: number; serverNow?: number } & PiRetryInfo
>;

/** Catalog metadata from another client: create, first-prompt title, or rename. */
export type PiSessionUpdatedEvent = PiEventEnvelope<
  'session.updated',
  {
    title: string;
  }
>;

export interface PiMessageStartPayload {
  messageId: string;
  role: 'assistant' | 'user';
  parentId?: string;
  /** User messages do not have a delta stream, so their text arrives here. */
  text?: string;
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
  /** True when Pi is about to execute tool calls from this assistant message. */
  continuing?: boolean;
  error?: PiError;
  /**
   * Pi-native usage for the turn that just ended. The daemon sanitizes the
   * raw Pi `Usage` (numbers only, finite, ≥ 0) before publishing so the UI
   * never sees NaN, strings, or unknown keys. Omitted when Pi did not
   * publish usage (e.g. an interrupted turn with no provider response).
   */
  usage?: PiUsage;
}

export interface PiAssistantMessageDeltaPayload {
  messageId: string;
  /** Optional part identity when the daemon exposes multiple text parts. */
  partId?: string;
  /** Pi content-block index; repeated deltas for one block share this value. */
  contentIndex: number;
  delta: string;
}

export interface PiAssistantThinkingDeltaPayload {
  messageId: string;
  /** Optional part identity when the daemon exposes multiple thinking parts. */
  partId?: string;
  /** Pi content-block index; repeated deltas for one block share this value. */
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
  /** Tool error message when the execution ended in an error state. */
  error?: string;
  /** Renderer metadata (edit diffs, truncation notes) without temp paths. */
  metadata?: Record<string, unknown>;
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
  | PiSessionUpdatedEvent
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
  'session.updated',
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
