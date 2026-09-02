import { formatTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import type {
  ManagedRemoteTunnelPreset,
  TtlOption,
  TunnelCheckResponse,
  TunnelDependencyInstallInfo,
  TunnelMode,
} from './tunnelTypes';

export const BOOTSTRAP_TTL_OPTIONS: TtlOption[] = [
  { value: '1800000', label: '30m', ms: 30 * 60 * 1000 },
  { value: '180000', label: '3m', ms: 3 * 60 * 1000 },
  { value: '7200000', label: '2h', ms: 2 * 60 * 60 * 1000 },
  { value: '28800000', label: '8h', ms: 8 * 60 * 60 * 1000 },
  { value: '86400000', label: '24h', ms: 24 * 60 * 60 * 1000 },
];

export const SESSION_TTL_OPTIONS: TtlOption[] = [
  { value: '3600000', label: '1h', ms: 60 * 60 * 1000 },
  { value: '28800000', label: '8h', ms: 8 * 60 * 60 * 1000 },
  { value: '43200000', label: '12h', ms: 12 * 60 * 60 * 1000 },
  { value: '86400000', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { value: '604800000', label: '1w', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '2592000000', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

export const MANAGED_REMOTE_TUNNEL_DOC_URL =
  'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/';
export const MANAGED_LOCAL_TUNNEL_DOC_URL =
  'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/';

export const TUNNEL_MODE_OPTIONS: Array<{
  value: TunnelMode;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'quick',
    label: 'Quick',
    tooltip: 'Quick Tunnel is best effort and uptime is not guaranteed.',
  },
  {
    value: 'managed-remote',
    label: 'Managed Remote',
    tooltip:
      'Managed Remote uses your Cloudflare account and hostname for long-lived access.',
  },
  {
    value: 'managed-local',
    label: 'Managed Local',
    tooltip: 'Managed Local uses your local cloudflared configuration file.',
  },
];

export const MANAGED_LOCAL_CONFIG_ALLOWED_EXTENSIONS = ['.yml', '.yaml', '.json'];
export const MANAGED_LOCAL_CONFIG_EXTENSION_ERROR_KEY =
  'Config file must use .yml, .yaml, or .json extension.';

export const hasAllowedManagedLocalConfigExtension = (filePath: string): boolean => {
  const normalized = filePath.trim().toLowerCase();
  return MANAGED_LOCAL_CONFIG_ALLOWED_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension)
  );
};

export const getProviderDependencyName = (): string => 'cloudflared';

export const getClientInstallPlatform = (): string => {
  if (
    typeof window !== 'undefined' &&
    typeof window.__PICHAMBER_PLATFORM__ === 'string'
  ) {
    const platform = window.__PICHAMBER_PLATFORM__;
    if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
      return platform;
    }
  }

  const browserPlatform =
    typeof navigator !== 'undefined'
      ? `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase()
      : '';
  if (browserPlatform.includes('win')) {
    return 'win32';
  }
  if (browserPlatform.includes('mac')) {
    return 'darwin';
  }
  return 'linux';
};

export const getFallbackInstallCommand = (
  platform = getClientInstallPlatform()
): string => {
  if (platform === 'win32') {
    return 'winget install --id Cloudflare.cloudflared';
  }
  if (platform === 'darwin') {
    return 'brew install cloudflared';
  }
  return 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflared/downloads/';
};

export const createTunnelDependencyInstallInfo = (
  provider: string,
  checkData?: TunnelCheckResponse
): TunnelDependencyInstallInfo => {
  const responseProvider =
    typeof checkData?.provider === 'string' && checkData.provider.trim().length > 0
      ? checkData.provider.trim().toLowerCase()
      : provider;
  const dependency =
    typeof checkData?.dependency === 'string' && checkData.dependency.trim().length > 0
      ? checkData.dependency.trim()
      : getProviderDependencyName();
  const platform =
    typeof checkData?.platform === 'string' && checkData.platform.trim().length > 0
      ? checkData.platform.trim()
      : getClientInstallPlatform();
  const installCommand =
    typeof checkData?.installCommand === 'string' &&
    checkData.installCommand.trim().length > 0
      ? checkData.installCommand.trim()
      : getFallbackInstallCommand(platform);

  return {
    provider: responseProvider,
    dependency,
    installCommand,
  };
};

export const getProviderLabel = (provider: string): string => {
  if (provider === 'cloudflare') {
    return 'Cloudflare';
  }
  return provider;
};

export const toUiTunnelMode = (mode: string | null | undefined): TunnelMode => {
  if (mode === 'quick') {
    return 'quick';
  }
  if (mode === 'managed-remote') {
    return 'managed-remote';
  }
  if (mode === 'managed-local') {
    return 'managed-local';
  }
  return 'quick';
};

export const ttlOptionValue = (
  options: TtlOption[],
  ttlMs: number | null,
  fallback: string
): string => {
  const matched = options.find((entry) => entry.ms === ttlMs);
  return matched?.value || fallback;
};

export const ttlOptionLabel = (
  options: TtlOption[],
  ttlMs: number | null,
  fallback: string
): string => {
  const value = ttlOptionValue(options, ttlMs, fallback);
  return options.find((entry) => entry.value === value)?.label || value;
};

export const formatRemaining = (remainingMs: number): string => {
  const safeMs = Math.max(0, remainingMs);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
};

export const formatAbsoluteTime = (
  timestamp: number,
  timeFormatPreference: TimeFormatPreference
): string => {
  return formatTimeForPreference(timestamp, timeFormatPreference, {
    hour: '2-digit',
    precision: 'second',
  });
};

export const normalizePresetHostname = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = trimmed.includes('://')
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return parsed.hostname.trim().toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};

export const sanitizePresets = (value: unknown): ManagedRemoteTunnelPreset[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  const seenHosts = new Set<string>();
  const result: ManagedRemoteTunnelPreset[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const hostname = normalizePresetHostname(
      typeof candidate.hostname === 'string' ? candidate.hostname : ''
    );
    if (!id || !name || !hostname) {
      continue;
    }
    if (seenIds.has(id) || seenHosts.has(hostname)) {
      continue;
    }
    seenIds.add(id);
    seenHosts.add(hostname);
    result.push({ id, name, hostname });
  }

  return result;
};

export const createPresetId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
