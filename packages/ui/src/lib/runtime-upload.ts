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

const supportsStreamingRequestBodies = (): boolean => {
  if (getActiveRelayTunnel()) return true;
  try {
    let duplexRead = false;
    const init = {
      method: 'POST',
      body: new ReadableStream<Uint8Array>(),
      get duplex() {
        duplexRead = true;
        return 'half' as const;
      },
    };
    const request = new Request('https://pichamber.invalid/upload-probe', init as RequestInit & { duplex: 'half' });
    return duplexRead && !request.headers.has('Content-Type');
  } catch {
    return false;
  }
};

/** Upload raw bytes through the active runtime transport, including relay mode. */
export const runtimeUpload = async (
  path: string,
  file: Blob,
  options: RuntimeUploadOptions,
): Promise<Response> => {
  const streaming = supportsStreamingRequestBodies();
  if (!streaming) options.onProgress?.({ loaded: 0, total: 0 });
  const request = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-PiChamber-Filename': encodeURIComponent(options.filename),
      'X-PiChamber-Mime': options.mime,
    },
    body: streaming ? streamBlob(file, options.signal, options.onProgress) : file,
    signal: options.signal,
    // Chromium requires this for streaming request bodies. The relay ignores it.
    ...(streaming ? { duplex: 'half' as const } : {}),
  } as RequestInit & { duplex?: 'half' };
  return runtimeFetch(path, request);
};
