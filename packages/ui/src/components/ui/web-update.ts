import { runtimeFetch } from '@/lib/runtime-fetch';

export type WebUpdateState = 'idle' | 'updating' | 'restarting' | 'reconnecting' | 'error';

export type InstallWebUpdateResult = {
  success: boolean;
  error?: string;
  autoRestart?: boolean;
  jobId?: string;
  commands?: string[];
};

type WebUpdateJob = {
  state?: 'queued' | 'installing' | 'verifying' | 'restarting' | 'complete' | 'failed';
  error?: string;
};

const WEB_UPDATE_POLL_INTERVAL_MS = 2000;
const WEB_UPDATE_MAX_WAIT_MS = 10 * 60 * 1000;

export async function installWebUpdate(): Promise<InstallWebUpdateResult> {
  try {
    const response = await runtimeFetch('/api/pi/update-install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return {
        success: false,
        error: data.error || `Server error: ${response.status}`,
        commands: Array.isArray(data.commands)
          ? data.commands.filter((command: unknown): command is string => typeof command === 'string')
          : undefined,
      };
    }

    const data = await response.json().catch(() => ({}));
    return {
      success: true,
      autoRestart: data.autoRestart !== false,
      jobId: typeof data.jobId === 'string' ? data.jobId : undefined,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : undefined };
  }
}

async function isServerReachable(): Promise<boolean> {
  try {
    const response = await runtimeFetch('/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForUpdateApplied(
  previousVersion?: string,
  maxAttempts = Math.ceil(WEB_UPDATE_MAX_WAIT_MS / WEB_UPDATE_POLL_INTERVAL_MS),
  intervalMs = WEB_UPDATE_POLL_INTERVAL_MS,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await runtimeFetch('/api/pi/update-check', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        const data = await response.json().catch(() => null);
        if (data && data.available === false) return true;
        if (
          data
          && typeof data.currentVersion === 'string'
          && typeof previousVersion === 'string'
          && data.currentVersion !== previousVersion
        ) {
          return true;
        }
      } else if ((response.status === 401 || response.status === 403) && await isServerReachable()) {
        return true;
      }
    } catch {
      // The server may be restarting.
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function waitForUpdateJob(
  jobId: string,
  onState: (state: WebUpdateState) => void,
  maxAttempts = Math.ceil(WEB_UPDATE_MAX_WAIT_MS / WEB_UPDATE_POLL_INTERVAL_MS),
  intervalMs = WEB_UPDATE_POLL_INTERVAL_MS,
): Promise<{ applied: boolean; error?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await runtimeFetch(`/api/pi/update-install/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        const job = await response.json().catch(() => null) as WebUpdateJob | null;
        if (job?.state === 'complete') return { applied: true };
        if (job?.state === 'failed') return { applied: false, error: job.error || 'Update failed' };
        if (job?.state === 'restarting') onState('restarting');
        else if (job?.state === 'queued' || job?.state === 'installing' || job?.state === 'verifying') onState('updating');
      } else if ((response.status === 401 || response.status === 403) && await isServerReachable()) {
        return { applied: true };
      } else if (response.status === 404) {
        return { applied: false, error: 'The server lost the update status. Check the installed version or run: pichamber update' };
      } else if (response.status === 503) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        if (data?.error === 'Update status is unavailable') return { applied: false, error: data.error };
        onState('reconnecting');
      } else {
        onState('reconnecting');
      }
    } catch {
      onState('reconnecting');
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return { applied: false };
}
