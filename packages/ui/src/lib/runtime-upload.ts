import { getActiveRelayTunnel } from './relay/runtime-tunnel';
import { runtimeFetch } from './runtime-fetch';

const UPLOAD_CHUNK_BYTES = 64 * 1024;

export type RuntimeUploadProgress = {
  loaded: number;
  total: number;
};

type RuntimeUploadOptions = {
  filename: string;
  mime: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeUploadProgress) => void;
};

const streamBlob = (
  blob: Blob,
  signal: AbortSignal | undefined,
  onProgress: RuntimeUploadOptions['onProgress'],
): ReadableStream<Uint8Array> => {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      if (offset >= blob.size) {
        controller.close();
        return;
      }
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, blob.size);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      offset = end;
      controller.enqueue(bytes);
      onProgress?.({ loaded: offset, total: blob.size });
    },
  });
};

/** Upload raw bytes through the active runtime transport, including relay mode. */
export const runtimeUpload = async (
  path: string,
  file: Blob,
  options: RuntimeUploadOptions,
): Promise<Response> => {
  const isRelay = Boolean(getActiveRelayTunnel());
  if (!isRelay) {
    options.onProgress?.({ loaded: 0, total: file.size });
  }
  const request = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-PiChamber-Filename': encodeURIComponent(options.filename),
      'X-PiChamber-Mime': options.mime,
    },
    body: isRelay ? streamBlob(file, options.signal, options.onProgress) : file,
    signal: options.signal,
    // ReadableStream request bodies require duplex:'half' in Chromium (supported in relay mode).
    // Direct native fetch uses Blob directly to avoid ERR_ALPN_NEGOTIATION_FAILED on HTTP/1.1.
    ...(isRelay ? { duplex: 'half' as const } : {}),
  } as RequestInit & { duplex?: 'half' };
  const response = await runtimeFetch(path, request);
  if (!isRelay && response.ok) {
    options.onProgress?.({ loaded: file.size, total: file.size });
  }
  return response;
};
