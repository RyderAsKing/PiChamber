/**
 * PiChamber-owned archive sidecar.
 *
 * PiChamber's archive hides sessions only inside PiChamber. It never edits
 * Pi JSONL or Pi CLI listing behavior. The archive record is a small JSON
 * file stored under the PiChamber data directory and is keyed by Pi session
 * identity (the canonical Pi session id).
 *
 * The store here is the browser-side boundary:
 *
 * - `loadArchive()` reads the cached sidecar so the sidebar can render
 *   archived sessions without a network round trip.
 * - `recordArchive()` posts the change to the server. The server owns
 *   persisting the file; this module only caches the result.
 * - `clearArchive()` is invoked when a session is deleted so the sidecar
 *   does not grow unbounded.
 *
 * The module intentionally avoids exposing any credential, pairing, or
 * bearer state — the archive sidecar is PiChamber-only metadata.
 */

import { runtimeFetch } from '@/lib/runtime-fetch';
import type { PiSessionId } from './types';
import { PiRequestError } from './client';

export interface PiArchiveRecord {
  sessionId: PiSessionId;
  archivedAt: number;
  /** Optional display label preserved across rename. */
  label?: string;
  /** Cached directory at archive time so the sidebar can re-list offline. */
  directory?: string;
}

export interface PiArchiveSnapshot {
  records: PiArchiveRecord[];
  /** Server-side stamp of the file's last write. */
  fetchedAt: number;
}

const EMPTY_SNAPSHOT: PiArchiveSnapshot = { records: [], fetchedAt: 0 };

export const loadArchive = async (signal?: AbortSignal): Promise<PiArchiveSnapshot> => {
  try {
    const response = await runtimeFetch('/api/pi/archive', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      return { ...EMPTY_SNAPSHOT };
    }
    const payload = (await response.json().catch(() => null)) as
      | { records?: PiArchiveRecord[]; fetchedAt?: number }
      | null;
    if (!payload || !Array.isArray(payload.records)) {
      return { ...EMPTY_SNAPSHOT };
    }
    return {
      records: payload.records.filter(
        (record): record is PiArchiveRecord =>
          Boolean(record && typeof record.sessionId === 'string' && Number.isFinite(record.archivedAt)),
      ),
      fetchedAt:
        typeof payload.fetchedAt === 'number' ? payload.fetchedAt : Date.now(),
    };
  } catch {
    // A network failure here is a missing cache, not authoritative empty data.
    return { ...EMPTY_SNAPSHOT };
  }
};

export const recordArchive = async (
  record: PiArchiveRecord,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await runtimeFetch('/api/pi/archive', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: record.sessionId, archivedAt: record.archivedAt, ...(record.label ? { label: record.label } : {}), ...(record.directory ? { directory: record.directory } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code: string; message?: string } } | null;
    throw new PiRequestError(
      body?.error?.code ?? 'DAEMON_REQUEST_FAILED',
      body?.error?.message ?? `Archive failed (${response.status})`,
      response.status,
    );
  }
};

export const clearArchive = async (
  sessionId: PiSessionId,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await runtimeFetch(
    `/api/pi/archive/${encodeURIComponent(sessionId)}`,
    {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok && response.status !== 404) {
    const body = (await response.json().catch(() => null)) as { error?: { code: string; message?: string } } | null;
    throw new PiRequestError(
      body?.error?.code ?? 'DAEMON_REQUEST_FAILED',
      body?.error?.message ?? `Clear archive failed (${response.status})`,
      response.status,
    );
  }
};

/** Local-only helper: build a fresh record for a given session. */
export const buildArchiveRecord = (params: {
  sessionId: PiSessionId;
  label?: string;
  directory?: string;
  now?: number;
}): PiArchiveRecord => ({
  sessionId: params.sessionId,
  archivedAt: params.now ?? Date.now(),
  ...(params.label ? { label: params.label } : {}),
  ...(params.directory ? { directory: params.directory } : {}),
});
