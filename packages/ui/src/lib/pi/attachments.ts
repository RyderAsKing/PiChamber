/**
 * Pi attachment helpers.
 *
 * The legacy inline base64 attachment model is removed; PiChamber uploads the
 * original bytes to the server, the server writes a temp file using a
 * Pi-style name, and the daemon hands the path to Pi tools. The helpers
 * here are the browser-side boundary:
 *
 * - `bytesToBase64` produces the JSON-safe payload the server expects.
 * - `sanitizeFilename` strips path components and control characters so
 *   the server can hand the result to `path.join` without traversal risk.
 * - `buildAttachmentPromptLine` produces a Pi-readable one-line summary
 *   the assistant can show in its reply without the heavy base64 payload.
 * - `normalizeAttachmentMime` maps MIME types the way the legacy client
 *   normalized them (e.g. HEIC → JPEG, text/markdown → text/plain).
 *
 * The module is pure (no fetch / DOM access beyond FileReader) so it can be
 * unit tested in isolation.
 */

const TEXT_LIKE_MIME_PREFIXES = ['text/'];
const TEXT_LIKE_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
  'application/x-shellscript',
  'application/octet-stream',
  'image/svg+xml',
]);

const HEIC_MIMES = new Set(['image/heic', 'image/heif']);

/** Bytes → base64 (no Buffer dependency so it works in any runtime). */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, index + chunk);
    binary += String.fromCharCode(...slice);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  // Buffer fallback for non-browser runtimes (tests, server-side renders).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BufferCtor = (globalThis as any).Buffer as { from(data: Uint8Array): { toString(encoding: string): string } } | undefined;
  if (BufferCtor) {
    return BufferCtor.from(bytes).toString('base64');
  }
  throw new Error('No base64 encoder available in this runtime');
};

/** File → base64 with explicit mime handling. */
export const fileToBase64 = async (file: { mime: string; url?: string }): Promise<string> => {
  if (file.url && file.url.startsWith('data:')) {
    const commaIndex = file.url.indexOf(',');
    if (commaIndex !== -1) {
      return file.url.slice(commaIndex + 1);
    }
  }
  // For callers that hand us a Blob-like with arrayBuffer().
  const maybeArrayBuffer = (file as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
  if (typeof maybeArrayBuffer === 'function') {
    const buffer = await maybeArrayBuffer.call(file);
    return bytesToBase64(new Uint8Array(buffer));
  }
  throw new Error('fileToBase64 requires a Blob-like object with arrayBuffer()');
};

/** Sanitize a filename so the server can hand it to `path.join` safely. */
export const sanitizeFilename = (input: string): string => {
  if (typeof input !== 'string') return 'attachment';
  // Strip directory separators and parent references first.
  const withoutSeparators = input.replace(/[\\/]/g, '_').replace(/\.\.+/g, '_');
  // Strip control characters and any remaining path-traversal residue.
  // The no-control-regex rule intentionally flags the range below;
  // the rule is wrong here because we *want* to strip control characters
  // from a user-supplied filename. The replacement is a no-op when no
  // control character is present.
  const cleaned = withoutSeparators
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned.length === 0) return 'attachment';
  // Trim to a reasonable maximum so the temp-file name stays short.
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
};

/** True when the MIME type should be normalized to `text/plain`. */
export const shouldNormalizeToTextPlain = (mime: string): boolean => {
  if (!mime) return false;
  const lower = mime.toLowerCase();
  if (lower === 'text/plain') return false;
  if (TEXT_LIKE_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return TEXT_LIKE_APPLICATION_TYPES.has(lower);
};

/** True when the MIME type needs HEIC → JPEG conversion. */
export const isHeicMime = (mime: string): boolean => HEIC_MIMES.has(mime.toLowerCase());

/** Normalize a mime for storage. The browser never does HEIC conversion
 *  itself any more — the server is responsible for the conversion — so
 *  the helper only re-labels text-like types. */
export const normalizeAttachmentMime = (mime: string): string => {
  if (!mime) return 'application/octet-stream';
  if (isHeicMime(mime)) return mime; // server converts HEIC before storing
  if (shouldNormalizeToTextPlain(mime)) return 'text/plain';
  return mime;
};

/**
 * Replace the mime inside a data: URL while preserving the encoding marker.
 * The browser hands the server a base64 string; the server doesn't care
 * about the data: prefix, but the legacy client used this trick to keep
 * inline attachments working. We expose it so legacy call sites that
 * still construct a data URL can normalize before sending.
 */
export const rewriteDataUrlMime = (dataUrl: string, nextMime: string): string => {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) return dataUrl;
  const meta = dataUrl.slice(5, commaIndex);
  const content = dataUrl.slice(commaIndex);
  const newMeta = meta.replace(/^[^;,]+/, nextMime);
  return `data:${newMeta}${content}`;
};

/** Build the assistant-facing summary line for an attachment. */
export const buildAttachmentPromptLine = (params: {
  filename: string;
  mime: string;
  size: number;
  attachmentId: string;
}): string => {
  const safeName = sanitizeFilename(params.filename);
  return `[attachment ${safeName} (${params.mime}, ${formatSize(params.size)}, id=${params.attachmentId})]`;
};

/** Format a byte size for display. */
export const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

/**
 * Validate an attachment upload before sending. The server runs the same
 * checks again; the browser check exists so we can reject early without
 * wasting bandwidth on a doomed upload.
 */
export interface AttachmentUploadValidation {
  ok: boolean;
  reason?: 'too-large' | 'invalid-mime' | 'empty';
  message?: string;
}

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MiB hard cap, matches Workstream 6.

const REJECTED_MIME_PREFIXES = ['application/x-msdownload', 'application/x-dosexec'];

export const validateAttachmentUpload = (params: {
  mime: string;
  filename: string;
  size: number;
}): AttachmentUploadValidation => {
  if (params.size <= 0) {
    return { ok: false, reason: 'empty', message: 'Attachment is empty' };
  }
  if (params.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: 'too-large', message: 'Attachment exceeds the 100 MB limit' };
  }
  const mime = (params.mime ?? '').toLowerCase();
  if (REJECTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
    return { ok: false, reason: 'invalid-mime', message: `Refusing to upload ${mime}` };
  }
  if (sanitizeFilename(params.filename) === 'attachment' && mime.length === 0) {
    return { ok: false, reason: 'invalid-mime', message: 'Attachment is missing a filename or mime type' };
  }
  return { ok: true };
};
