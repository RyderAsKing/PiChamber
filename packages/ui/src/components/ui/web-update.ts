import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeEndpointGeneration } from '@/lib/runtime-switch';

export type WebUpdateState = 'idle' | 'updating' | 'restarting' | 'reconnecting' | 'error';

export type InstallWebUpdateResult = {
  success: boolean;
  error?: string;
  autoRestart?: boolean;
  jobId?: string;
  commands?: string[];
  channel?: 'stable' | 'rc';
  targetVersion?: string;
};

type WebUpdateJob = {
  state?: 'queued' | 'installing' | 'verifying' | 'restarting' | 'complete' | 'failed';
  error?: string;
};

const WEB_UPDATE_POLL_INTERVAL_MS = 2000;
const WEB_UPDATE_MAX_WAIT_MS = 10 * 60 * 1000;

type UpdateObservationResult = { applied: boolean; error?: string; stale?: boolean };

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
      channel: data.channel === 'rc' ? 'rc' : data.channel === 'stable' ? 'stable' : undefined,
      targetVersion: typeof data.targetVersion === 'string' ? data.targetVersion : undefined,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : undefined };
  }
}

export async function waitForUpdateApplied(
  previousVersion?: string,
  maxAttempts = Math.ceil(WEB_UPDATE_MAX_WAIT_MS / WEB_UPDATE_POLL_INTERVAL_MS),
  intervalMs = WEB_UPDATE_POLL_INTERVAL_MS,
  runtimeGeneration = getRuntimeEndpointGeneration(),
): Promise<UpdateObservationResult> {
  for (let i = 0; i < maxAttempts; i++) {
    if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
    try {
      const response = await runtimeFetch('/api/pi/update-check', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
      if (response.ok) {
        const data = await response.json().catch(() => null);
        if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
        if (typeof data?.error === 'string' && data.error.length > 0) {
          return { applied: false, error: data.error };
        }
        if (data && data.available === false) return { applied: true };
        if (
          data
          && typeof data.currentVersion === 'string'
          && typeof previousVersion === 'string'
          && data.currentVersion !== previousVersion
        ) {
          return { applied: true };
        }
      } else if (response.status === 401 || response.status === 403) {
        return {
          applied: false,
          error: 'Authentication was lost while following the update. Reauthenticate to check its status.',
        };
      }
    } catch {
      if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
      // The server may be restarting.
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return { applied: false };
}

export async function waitForUpdateJob(
  jobId: string,
  onState: (state: WebUpdateState) => void,
  maxAttempts = Math.ceil(WEB_UPDATE_MAX_WAIT_MS / WEB_UPDATE_POLL_INTERVAL_MS),
  intervalMs = WEB_UPDATE_POLL_INTERVAL_MS,
  runtimeGeneration = getRuntimeEndpointGeneration(),
): Promise<UpdateObservationResult> {
  for (let i = 0; i < maxAttempts; i++) {
    if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
    try {
      const response = await runtimeFetch(`/api/pi/update-install/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
      if (response.ok) {
        const job = await response.json().catch(() => null) as WebUpdateJob | null;
        if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
        if (job?.state === 'complete') return { applied: true };
        if (job?.state === 'failed') return { applied: false, error: job.error || 'Update failed' };
        if (job?.state === 'restarting') onState('restarting');
        else if (job?.state === 'queued' || job?.state === 'installing' || job?.state === 'verifying') onState('updating');
      } else if (response.status === 401 || response.status === 403) {
        return {
          applied: false,
          error: 'Authentication was lost while following the update. Reauthenticate to check its status.',
        };
      } else if (response.status === 404) {
        return { applied: false, error: 'The server lost the update status. Check the installed version or run: pichamber update' };
      } else if (response.status === 503) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
        if (data?.error === 'Update status is unavailable') return { applied: false, error: data.error };
        onState('reconnecting');
      } else {
        onState('reconnecting');
      }
    } catch {
      if (getRuntimeEndpointGeneration() !== runtimeGeneration) return { applied: false, stale: true };
      onState('reconnecting');
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return { applied: false };
}
