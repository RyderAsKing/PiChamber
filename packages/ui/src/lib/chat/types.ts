/**
 * PiChamber-owned render/session types used by the restored PiChamber UI.
 * They replace `@/lib/chat/types` at the TypeScript/bundler boundary.
 */

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy'; [key: string]: unknown }
  | { type: 'retry'; message?: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface Session {
  id: string;
  slug?: string;
  projectID?: string;
  directory?: string;
  parentID?: string | null;
  title?: string;
  /** Total message count from the most recent authoritative snapshot, when known. */
  messageCount?: number;
  version?: string;
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
    compacting?: number;
  };
  summary?: { additions?: number; deletions?: number };
  share?: { url?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Message {
  id: string;
  sessionID?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string; message?: string; data?: { message?: string } };
  agent?: string;
  model?: { providerID?: string; modelID?: string } | string;
  finish?: string;
  [key: string]: unknown;
}

export interface TextPart {
  id: string;
  type: 'text';
  text?: string;
  synthetic?: boolean;
  [key: string]: unknown;
}

export interface ReasoningPart {
  id: string;
  type: 'reasoning';
  text?: string;
  time?: { start?: number; end?: number };
  [key: string]: unknown;
}

export interface FilePart {
  id: string;
  type: 'file';
  mime?: string;
  filename?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ToolState {
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
  [key: string]: unknown;
}

export interface ToolPart {
  id: string;
  type: 'tool';
  tool?: string;
  callID?: string;
  state?: ToolState;
  [key: string]: unknown;
}

export type Part = TextPart | ReasoningPart | FilePart | ToolPart | {
  id: string;
  type: string;
  text?: string;
  [key: string]: unknown;
};

export interface Provider {
  id: string;
  name?: string;
  models?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Agent {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface Command {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface Config {
  [key: string]: unknown;
}

export interface Project {
  id: string;
  worktree?: string;
  [key: string]: unknown;
}

export interface Path {
  directory?: string;
  [key: string]: unknown;
}

export interface Todo {
  id?: string;
  content?: string;
  status?: string;
  [key: string]: unknown;
}

export interface LspStatus {
  [key: string]: unknown;
}

export interface McpStatus {
  [key: string]: unknown;
}

export interface VcsInfo {
  [key: string]: unknown;
}

export interface PermissionRequest {
  id: string;
  [key: string]: unknown;
}

export interface QuestionRequest {
  id: string;
  [key: string]: unknown;
}

export interface ProviderListResponse {
  all?: Provider[];
  [key: string]: unknown;
}

export interface ProviderAuthResponse {
  [key: string]: unknown;
}

export type SessionMessageRecord = { info: Message; parts: Part[] };

export type Event = {
  type: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};
