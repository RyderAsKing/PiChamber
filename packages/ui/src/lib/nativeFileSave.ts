import { registerPlugin } from '@capacitor/core';
import { getClientPlatform } from '@/lib/platform';

export type NativeFileSaveResult = 'shared' | 'downloaded' | 'cancelled';

export interface SaveOrShareFileOptions {
  filename: string;
  mimeType?: string;
  data: Blob | string;
}

interface PiChamberFilesPlugin {
  share(options: { filename: string; mimeType?: string; base64: string }): Promise<{ status?: string }>;
  setWebViewBackground(options: { color: string }): Promise<void>;
}

const PiChamberFiles = registerPlugin<PiChamberFilesPlugin>('PiChamberFiles');

export function isShareCancelledError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message.includes('AbortError') ||
      error.message.toLowerCase().includes('cancel'))
  );
}

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const dataToBase64 = async (data: Blob | string, mimeType?: string): Promise<string> => {
  if (typeof data === 'string') {
    if (data.startsWith('data:')) {
      const commaIndex = data.indexOf(',');
      if (commaIndex !== -1 && data.slice(0, commaIndex).includes(';base64')) {
        return data.slice(commaIndex + 1);
      }
    }
    const blob = new Blob([data], { type: mimeType ?? 'text/plain;charset=utf-8' });
    return blobToBase64(blob);
  }
  return blobToBase64(data);
};

const dataToFile = async (data: Blob | string, filename: string, mimeType?: string): Promise<File> => {
  if (data instanceof File) {
    return data;
  }
  if (data instanceof Blob) {
    return new File([data], filename, { type: mimeType || data.type || 'application/octet-stream' });
  }
  if (typeof data === 'string' && data.startsWith('data:')) {
    const blob = await (await fetch(data)).blob();
    return new File([blob], filename, { type: mimeType || blob.type || 'application/octet-stream' });
  }
  return new File([data], filename, { type: mimeType ?? 'text/plain;charset=utf-8' });
};

const triggerAnchorDownload = (filename: string, data: Blob | string, mimeType?: string): void => {
  if (typeof document === 'undefined') return;

  const isDataUrl = typeof data === 'string' && data.startsWith('data:');
  const url = isDataUrl
    ? data
    : URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mimeType || 'application/octet-stream' }));

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  if (!isDataUrl) {
    URL.revokeObjectURL(url);
  }
};

export async function saveOrShareFile({
  filename,
  mimeType,
  data,
}: SaveOrShareFileOptions): Promise<NativeFileSaveResult> {
  const platform = getClientPlatform();

  // Capacitor Android: native share sheet via local PiChamberFiles plugin
  if (platform === 'android') {
    const base64 = await dataToBase64(data, mimeType);
    await PiChamberFiles.share({
      filename,
      mimeType,
      base64,
    });
    return 'shared';
  }

  // Capacitor iOS: Web Share API with File if canShare supports files
  if (platform === 'ios') {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      const file = await dataToFile(data, filename, mimeType);
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return 'shared';
        } catch (error) {
          if (isShareCancelledError(error)) {
            return 'cancelled';
          }
          throw error;
        }
      }
    }
  }

  // Web / Desktop / Hosted Browser / iOS fallback: standard anchor download
  triggerAnchorDownload(filename, data, mimeType);
  return 'downloaded';
}

export async function setNativeWebViewBackground(color: string): Promise<void> {
  const platform = getClientPlatform();
  if (platform !== 'android') return;
  try {
    await PiChamberFiles.setWebViewBackground({ color });
  } catch {
    // Silently ignore if plugin is missing or fails (e.g. older native binary)
  }
}
