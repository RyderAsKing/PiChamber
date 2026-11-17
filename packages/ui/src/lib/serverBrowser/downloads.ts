import type { ServerBrowserDownload, ServerBrowserMessage } from './protocol';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export const formatDownloadBytes = (bytes: number): string => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** A download's second line: how far it has come, or how it ended. */
export const downloadStatusText = (download: ServerBrowserDownload): string => {
  const host = download.url ? hostOf(download.url) : '';
  const withHost = (text: string) => (host ? `${text} · ${host}` : text);
  switch (download.state) {
    case 'inProgress':
      return download.totalBytes > 0
        ? `${formatDownloadBytes(download.receivedBytes)} of ${formatDownloadBytes(download.totalBytes)}`
        : `${formatDownloadBytes(download.receivedBytes)} so far`;
    case 'completed':
      return withHost(formatDownloadBytes(download.totalBytes));
    case 'canceled':
      return withHost('Canceled');
    default:
      return withHost('Failed');
  }
};

/** The download a `download` message describes. */
export const downloadFromMessage = (message: Extract<ServerBrowserMessage, { type: 'download' }>): ServerBrowserDownload => ({
  id: message.id,
  filename: message.filename,
  url: message.url ?? '',
  state: message.state,
  receivedBytes: message.receivedBytes,
  totalBytes: message.totalBytes,
  path: message.path ?? null,
  savedPath: message.savedPath ?? null,
  startedAt: message.startedAt,
});

/** `downloads` with `download` replacing the entry of the same id, or added last. */
export const upsertDownload = (downloads: ServerBrowserDownload[], download: ServerBrowserDownload): ServerBrowserDownload[] => {
  const index = downloads.findIndex((entry) => entry.id === download.id);
  if (index === -1) return [...downloads, download];
  const next = downloads.slice();
  next[index] = download;
  return next;
};
