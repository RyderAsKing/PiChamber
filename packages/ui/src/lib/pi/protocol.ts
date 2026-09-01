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
  PiCompactionInfo,
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

export interface PiSessionDetailResponse extends Pick<
  PiSessionSnapshot,
  | 'extensionStatuses'
  | 'extensionWidgets'
  | 'extensionDialogs'
  | 'extensionPanels'
  | 'extensionApps'
  | 'extensionTitle'
> {
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
  /** Latest active or completed compaction state. */
  compaction?: PiCompactionInfo;
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
  /** Optional instructions for the compaction summary. */
  customInstructions?: string;
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
  /** Latest Pi label/bookmark attached to this history entry. */
  label?: string;
  labelTimestamp?: string;
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
  attachment: PiAttachment & { expiresAt: number };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Discriminator for the public event stream. */
export type PiEventName =
  | 'session.snapshot'
  | 'session.lifecycle'
  | 'session.updated'
  | 'session.tree.updated'
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
  | 'session.interrupted'
  | 'extension.entry'
  | 'extension.message'
  | 'extension.notify'
  | 'extension.catalog'
  | 'extension.editor'
  | 'extension.title'
  | 'extension.status'
  | 'extension.widget'
  | 'extension.dialog'
  | 'extension.dialog.dismiss'
  | 'extension.ui'
  | 'extension.app'
  | 'extension.error';

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

/** A Pi label/bookmark changed; mounted tree consumers should refetch. */
export type PiSessionTreeUpdatedEvent = PiEventEnvelope<'session.tree.updated', Record<string, never>>;

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
  PiCompactionInfo
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

// ---------------------------------------------------------------------------
// Extensions
//
// pi extensions run inside the session daemon. Their user-facing surface is
// projected onto these public events; blocking dialogs are answered through
// POST /api/pi/extensions/respond.
// ---------------------------------------------------------------------------

/** A custom entry appended via `pi.appendEntry(customType, data)`. */
export type PiExtensionEntryEvent = PiEventEnvelope<
  'extension.entry',
  {
    id: string;
    customType: string;
    data?: unknown;
    createdAt: number;
  }
>;

/** A custom message sent via `pi.sendMessage({ customType, content, display })`. */
export type PiExtensionMessageEvent = PiEventEnvelope<
  'extension.message',
  {
    id: string;
    customType: string;
    text: string;
    details?: unknown;
    createdAt: number;
  }
>;

export type PiExtensionNotifyEvent = PiEventEnvelope<
  'extension.notify',
  {
    message: string;
    level: 'info' | 'warning' | 'error';
  }
>;

/** Extension-owned catalogs changed inside the daemon and should be reloaded. */
export type PiExtensionCatalogEvent = PiEventEnvelope<
  'extension.catalog',
  { providers?: true; resources?: true; commands?: true }
>;

/** Standard Pi RPC editor replacement for the owning session composer. */
export type PiExtensionEditorEvent = PiEventEnvelope<'extension.editor', { text: string }>;

/** Standard Pi RPC window/tab title; no title clears the session override. */
export type PiExtensionTitleEvent = PiEventEnvelope<'extension.title', { title?: string }>;

/** Status text keyed like `ctx.ui.setStatus(key, text)`; no `text` clears. */
export type PiExtensionStatusEvent = PiEventEnvelope<
  'extension.status',
  {
    key: string;
    text?: string;
  }
>;

/** Widget lines keyed like `ctx.ui.setWidget(key, lines)`; no `lines` clears. */
export type PiExtensionWidgetEvent = PiEventEnvelope<
  'extension.widget',
  {
    key: string;
    lines?: string[];
    placement?: 'aboveEditor' | 'belowEditor';
  }
>;

/** One typed input of a `form` dialog (`ctx.ui.form`). */
export interface PiExtensionFormField {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox';
  required?: boolean;
  placeholder?: string;
  /** Select choices. */
  options?: string[];
  /** Initial value as a string (checkbox: 'true'/'false'). */
  initial?: string;
  min?: number;
  max?: number;
}

export interface PiExtensionDialogPayload {
  requestId: string;
  method: 'select' | 'confirm' | 'input' | 'editor' | 'form';
  title: string;
  /** Confirm/dialog body text. */
  message?: string;
  /** Select choices. */
  options?: string[];
  /** Input placeholder. */
  placeholder?: string;
  /** Editor prefill. */
  prefill?: string;
  /** Form dialog inputs. */
  fields?: PiExtensionFormField[];
  /** When present, the dialog auto-cancels after this many milliseconds. */
  timeoutMs?: number;
}

export type PiExtensionDialogEvent = PiEventEnvelope<'extension.dialog', PiExtensionDialogPayload>;

/** Authoritative removal of a dialog after response, timeout, abort, or runtime disposal. */
export type PiExtensionDialogDismissEvent = PiEventEnvelope<
  'extension.dialog.dismiss',
  { requestId: string; reason: 'answered' | 'cancelled' | 'timeout' | 'aborted' | 'session-closed' | 'daemon-stopped' }
>;

/** Answer for a blocking extension dialog. Omit all answer fields to cancel. */
export interface PiExtensionDialogResponseInput {
  requestId: string;
  directory?: string;
  /** Explicit cancellation (Escape). */
  cancelled?: boolean;
  /** Confirm-dialog acceptance; absent/`false` declines. */
  confirmed?: boolean;
  /** Select choice, input text, or editor content. */
  value?: string;
  /** Form dialog answers keyed by field id. */
  values?: Record<string, string>;
}

/** Declarative GUI panel update keyed by a stable id; latest wins. */
export interface PiExtensionPanelPayload {
  id: string;
  title?: string;
  component?: string;
  props?: Record<string, unknown>;
  actions?: unknown[];
  /** Present when the panel should be removed from the live dock. */
  removed?: boolean;
}

export type PiExtensionUiEvent = PiEventEnvelope<'extension.ui', PiExtensionPanelPayload>;

/** Sandboxed extension app surface; `removed` (or missing `html`) unregisters. */
export interface PiExtensionAppPayload {
  appId: string;
  title?: string;
  /** Self-contained HTML document rendered inside a sandboxed iframe. */
  html?: string;
  removed?: boolean;
}

export type PiExtensionAppEvent = PiEventEnvelope<'extension.app', PiExtensionAppPayload>;

/** Extensions loaded for a directory plus the slash commands they register. */
export interface PiExtensionListResponse {
  directory?: string;
  /** Opaque ids only — server filesystem paths never cross the API. */
  extensions: Array<{ id: string; name: string }>;
  commands: Array<{
    name: string;
    description?: string;
    source?: 'extension' | 'prompt' | 'skill';
    scope?: 'user' | 'project' | 'temporary';
  }>;
}
export type PiExtensionErrorEvent = PiEventEnvelope<
  'extension.error',
  {
    /** Extension path or `<runtime>` source label reported by pi. */
    source: string;
    event?: string;
    message: string;
  }
>;

/** Discriminated union of every event the public stream can publish. */
export type PiSessionEvent =
  | PiSessionSnapshotEvent
  | PiSessionLifecycleEvent
  | PiSessionUpdatedEvent
  | PiSessionTreeUpdatedEvent
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
  | PiSessionInterruptedEvent
  | PiExtensionEntryEvent
  | PiExtensionMessageEvent
  | PiExtensionNotifyEvent
  | PiExtensionCatalogEvent
  | PiExtensionEditorEvent
  | PiExtensionTitleEvent
  | PiExtensionStatusEvent
  | PiExtensionWidgetEvent
  | PiExtensionDialogEvent
  | PiExtensionDialogDismissEvent
  | PiExtensionUiEvent
  | PiExtensionAppEvent
  | PiExtensionErrorEvent;

// ---------------------------------------------------------------------------
// Snapshot / protocol helpers
// ---------------------------------------------------------------------------

/** A snapshot is also a valid event for code that reduces both. */
export const PI_EVENT_KINDS = [
  'session.snapshot',
  'session.lifecycle',
  'session.updated',
  'session.tree.updated',
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
  'extension.entry',
  'extension.message',
  'extension.notify',
  'extension.catalog',
  'extension.editor',
  'extension.title',
  'extension.status',
  'extension.widget',
  'extension.dialog',
  'extension.dialog.dismiss',
  'extension.ui',
  'extension.app',
  'extension.error',
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
