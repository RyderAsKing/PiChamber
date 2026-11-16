import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { saveServerBrowserDownload, saveServerBrowserDownloadToServer } from '@/lib/serverBrowser/api';
import { downloadStatusText, formatDownloadBytes } from '@/lib/serverBrowser/downloads';
import type { ServerBrowserDownload } from '@/lib/serverBrowser/protocol';

type DeviceSave =
  | { state: 'saving'; receivedBytes: number; totalBytes: number }
  | { state: 'saved' }
  | { state: 'failed' };

const ProgressBar: React.FC<{ fraction: number | null; label: string }> = ({ fraction, label }) => {
  const clamped = fraction === null ? null : Math.min(1, Math.max(0, fraction));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(clamped !== null ? { 'aria-valuenow': Math.round(clamped * 100) } : {})}
      className="h-1 w-full overflow-hidden rounded-full bg-[var(--interactive-border)]"
    >
      {/* Unknown sizes show an empty track; the text says how much came. */}
      <div
        className="h-full w-full origin-left rounded-full bg-[var(--primary-base)] transition-transform duration-200"
        style={{ transform: `scaleX(${clamped ?? 0})` }}
      />
    </div>
  );
};

const DownloadRow: React.FC<{
  download: ServerBrowserDownload;
  deviceSave: DeviceSave | undefined;
  savingToServer: boolean;
  onCancel: () => void;
  onSaveToDevice: () => void;
  onSaveToServer: () => void;
  onCopyPath: () => void;
}> = ({ download, deviceSave, savingToServer, onCancel, onSaveToDevice, onSaveToServer, onCopyPath }) => {
  const done = download.state === 'completed';
  const ended = download.state === 'canceled' || download.state === 'failed';
  const copying = deviceSave?.state === 'saving';
  let status = downloadStatusText(download);
  if (copying) {
    status = deviceSave.totalBytes > 0
      ? `Copying to this device: ${formatDownloadBytes(deviceSave.receivedBytes)} of ${formatDownloadBytes(deviceSave.totalBytes)}`
      : 'Copying to this device';
  } else if (done && download.savedPath) {
    status = `Saved on the server: ${download.savedPath}`;
  } else if (done && deviceSave?.state === 'saved') {
    status = `${status} · Saved to this device`;
  }

  return (
    <li className="flex items-start gap-2.5 px-3 py-2">
      <FileTypeIcon filePath={download.filename} className={ended ? 'mt-0.5 size-5 shrink-0 opacity-50' : 'mt-0.5 size-5 shrink-0'} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={ended ? 'truncate typography-meta text-muted-foreground line-through' : 'truncate typography-meta text-foreground'} title={download.filename}>
              {download.filename}
            </span>
            <span
              className={download.state === 'failed' ? 'truncate typography-micro text-[var(--status-error)]' : 'truncate typography-micro text-muted-foreground'}
              title={status}
            >
              {status}
            </span>
          </div>
          {download.state === 'inProgress' ? (
            <Button type="button" variant="ghost" size="xs" onClick={onCancel}>{'Cancel'}</Button>
          ) : null}
        </div>
        {download.state === 'inProgress' ? (
          <ProgressBar
            fraction={download.totalBytes > 0 ? download.receivedBytes / download.totalBytes : null}
            label={`Downloading ${download.filename} on the server`}
          />
        ) : null}
        {copying ? (
          <ProgressBar
            fraction={deviceSave.totalBytes > 0 ? deviceSave.receivedBytes / deviceSave.totalBytes : null}
            label={`Copying ${download.filename} to this device`}
          />
        ) : null}
        {done ? (
          // Ghost buttons pulled left by their padding, so their icons line up with the text.
          <div className="-ml-1.5 flex flex-wrap items-center gap-1">
            <Button type="button" variant="ghost" size="xs" disabled={copying} onClick={onSaveToDevice}>
              <Icon name="download" className="size-3.5" />
              {'Save to this device'}
            </Button>
            {download.savedPath ? null : (
              <Button type="button" variant="ghost" size="xs" disabled={savingToServer} onClick={onSaveToServer} title="Copy it into the Downloads folder on the server">
                <Icon name="server" className="size-3.5" />
                {savingToServer ? 'Saving...' : 'Save to server'}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onCopyPath}
              title={download.savedPath ? 'Copy where the file is on the server' : 'Copy where the file waits on the server (temporary)'}
            >
              <Icon name="file-copy" className="size-3.5" />
              {'Copy path'}
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
};

/**
 * The downloads of a server browser page, under the page: progress while
 * the server downloads, then saving a copy to this device or to the
 * server's Downloads folder, and copying where the file is on the server.
 * Stays mounted while hidden, so a copy in progress keeps going.
 */
export const ServerBrowserDownloads: React.FC<{
  downloads: ServerBrowserDownload[];
  open: boolean;
  onClose: () => void;
  onCancel: (id: string) => void;
}> = ({ downloads, open, onClose, onCancel }) => {
  const [deviceSaves, setDeviceSaves] = React.useState<Record<string, DeviceSave>>({});
  const [serverSaving, setServerSaving] = React.useState<Record<string, boolean>>({});

  const setDeviceSave = (id: string, next: DeviceSave) => setDeviceSaves((current) => ({ ...current, [id]: next }));

  const saveToDevice = async (download: ServerBrowserDownload) => {
    setDeviceSave(download.id, { state: 'saving', receivedBytes: 0, totalBytes: download.totalBytes });
    try {
      const result = await saveServerBrowserDownload(download.id, download.filename, {
        onProgress: (receivedBytes, totalBytes) => setDeviceSave(download.id, { state: 'saving', receivedBytes, totalBytes }),
      });
      setDeviceSave(download.id, result === 'cancelled' ? { state: 'failed' } : { state: 'saved' });
    } catch (error) {
      setDeviceSave(download.id, { state: 'failed' });
      toast.error(error instanceof Error ? error.message : `Could not save ${download.filename} to this device`);
    }
  };

  const saveToServer = async (download: ServerBrowserDownload) => {
    setServerSaving((current) => ({ ...current, [download.id]: true }));
    try {
      const savedPath = await saveServerBrowserDownloadToServer(download.id);
      toast.success(`Saved ${download.filename} on the server`, {
        description: savedPath,
        action: { label: 'Copy path', onClick: () => void copyPath(savedPath) },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not save ${download.filename} on the server`);
    } finally {
      setServerSaving((current) => ({ ...current, [download.id]: false }));
    }
  };

  const copyPath = async (path: string) => {
    const result = await copyTextToClipboard(path);
    if (result.ok) toast.success('Path copied', { description: path });
    else toast.error('Could not copy the path', { description: path });
  };

  if (!open || downloads.length === 0) return null;
  const newestFirst = [...downloads].reverse();
  const active = downloads.filter((download) => download.state === 'inProgress').length;

  return (
    <section aria-label="Downloads" className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-border bg-[var(--surface-elevated)]">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1">
        <span className="min-w-0 flex-1 typography-micro text-muted-foreground">
          {active > 0 ? `Downloading on the server (${active})` : 'Downloaded on the server'}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose} title="Hide downloads" aria-label="Hide downloads">
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
        {newestFirst.map((download) => (
          <DownloadRow
            key={download.id}
            download={download}
            deviceSave={deviceSaves[download.id]}
            savingToServer={serverSaving[download.id] === true}
            onCancel={() => onCancel(download.id)}
            onSaveToDevice={() => void saveToDevice(download)}
            onSaveToServer={() => void saveToServer(download)}
            onCopyPath={() => {
              const path = download.savedPath ?? download.path;
              if (path) void copyPath(path);
            }}
          />
        ))}
      </ul>
    </section>
  );
};
