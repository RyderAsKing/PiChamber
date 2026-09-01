export type AttachmentUploadState =
    | { status: "preparing" }
    | { status: "uploading"; progress: number | null }
    | { status: "ready"; attachmentId: string; expiresAt: number }
    | { status: "failed"; error: string };

export interface AttachedFile {
    id: string;
    file: File;
    /** Kept for local preview and persisted queue refreshes. Never sent in the normal prompt path. */
    dataUrl: string;
    /** Ephemeral object URL for draft image previews. Never persisted or sent. */
    previewUrl?: string;
    mimeType: string;
    filename: string;
    size: number;
    source: "local" | "server";
    /** Local files use the upload lifecycle. Omitted only by legacy persisted queue entries. */
    uploadState?: AttachmentUploadState;
    serverPath?: string;
    /** Shared ID linking entries extracted from the same document (PPTX, DOCX, etc.).
     *  Removing any entry with this ID cascades to all entries in the group. */
    sourceDocumentId?: string;
}

export const hasPendingAttachmentUploads = (files: readonly AttachedFile[]): boolean =>
    files.some((file) => file.source === "local" && (file.uploadState?.status === "preparing" || file.uploadState?.status === "uploading"));

export const hasFailedAttachmentUploads = (files: readonly AttachedFile[]): boolean =>
    files.some((file) => file.source === "local" && file.uploadState?.status === "failed");

export const areAttachmentsReadyToSend = (files: readonly AttachedFile[], now = Date.now()): boolean =>
    files.every((file) => file.source === "server" || (file.uploadState?.status === "ready" && file.uploadState.expiresAt > now));

export type EditPermissionMode = 'allow' | 'ask' | 'deny' | 'full';

export type MessageStreamPhase = 'streaming' | 'cooldown' | 'completed';

export interface SessionHistoryMeta {
    limit: number;
    complete: boolean;
    loading: boolean;
}

export interface SessionContextUsage {
    totalTokens: number;
    percentage: number;
    contextLimit: number;
    outputLimit?: number;
    normalizedOutput?: number;
    thresholdLimit: number;
    lastMessageId?: string;
}

// Default message limit (can be overridden via settings).
// Single value controls: fetch from server, active session ceiling, Load More chunk.
// Background trim is derived automatically as Math.round(limit * 0.6).
const DEFAULT_MESSAGE_LIMIT = 200;
const MEMORY_CONSTANTS = {
    MAX_SESSIONS: 3,
    ZOMBIE_TIMEOUT: 10 * 60 * 1000,
} as const;

/** Fixed page/window size for message history. */
const getMessageLimit = (): number => {
    return DEFAULT_MESSAGE_LIMIT;
};

/** Background trim target — automatic, not user-facing. */
export const getBackgroundTrimLimit = (): number =>
    Math.round(getMessageLimit() * 0.6);

// --- Backward-compat shims (avoid mass refactor of non-critical callers) ---
const DEFAULT_MEMORY_LIMITS = {
    MAX_SESSIONS: MEMORY_CONSTANTS.MAX_SESSIONS,
    VIEWPORT_MESSAGES: Math.round(DEFAULT_MESSAGE_LIMIT * 0.6),
    HISTORICAL_MESSAGES: DEFAULT_MESSAGE_LIMIT,
    FETCH_BUFFER: 20,
    HISTORY_CHUNK: DEFAULT_MESSAGE_LIMIT,
    STREAMING_BUFFER: Infinity,
    ZOMBIE_TIMEOUT: MEMORY_CONSTANTS.ZOMBIE_TIMEOUT,
} as const;

export const getMemoryLimits = () => {
    const limit = getMessageLimit();
    const bgTrim = getBackgroundTrimLimit();
    return {
        ...DEFAULT_MEMORY_LIMITS,
        HISTORICAL_MESSAGES: limit,
        VIEWPORT_MESSAGES: bgTrim,
        HISTORY_CHUNK: limit,
    };
};
