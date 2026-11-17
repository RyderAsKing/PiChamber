import { describe, expect, test } from 'bun:test';

import { downloadFromMessage, downloadStatusText, formatDownloadBytes, upsertDownload } from './downloads';
import type { ServerBrowserDownload } from './protocol';

const download = (overrides: Partial<ServerBrowserDownload> = {}): ServerBrowserDownload => ({
  id: 'a',
  filename: 'report.pdf',
  url: 'https://files.example/report.pdf',
  state: 'inProgress',
  receivedBytes: 0,
  totalBytes: 0,
  path: null,
  savedPath: null,
  startedAt: 1,
  ...overrides,
});

describe('server browser downloads', () => {
  test('formats sizes', () => {
    expect(formatDownloadBytes(512)).toBe('512 B');
    expect(formatDownloadBytes(1536)).toBe('1.5 KB');
    expect(formatDownloadBytes(25 * 1024 * 1024)).toBe('25 MB');
  });

  test('describes progress and how a download ended', () => {
    expect(downloadStatusText(download({ receivedBytes: 1024, totalBytes: 4096 }))).toBe('1.0 KB of 4.0 KB');
    expect(downloadStatusText(download({ receivedBytes: 2048 }))).toBe('2.0 KB so far');
    expect(downloadStatusText(download({ state: 'completed', totalBytes: 4096 }))).toBe('4.0 KB · files.example');
    expect(downloadStatusText(download({ state: 'failed' }))).toBe('Failed · files.example');
    expect(downloadStatusText(download({ state: 'canceled', url: '' }))).toBe('Canceled');
  });

  test('reads messages from older servers without the newer fields', () => {
    const message = { type: 'download', id: 'a', filename: 'notes.txt', state: 'completed', receivedBytes: 3, totalBytes: 3 } as unknown as Parameters<typeof downloadFromMessage>[0];
    expect(downloadFromMessage(message)).toMatchObject({ url: '', path: null, savedPath: null });
  });

  test('updates a download in place and adds new ones last', () => {
    const first = download();
    const list = upsertDownload([first], download({ id: 'b' }));
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b']);
    const updated = upsertDownload(list, download({ receivedBytes: 10 }));
    expect(updated.map((entry) => [entry.id, entry.receivedBytes])).toEqual([['a', 10], ['b', 0]]);
  });
});
