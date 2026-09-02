export type TunnelState =
  | 'checking'
  | 'not-available'
  | 'idle'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'error';

export type TtlOption = { value: string; label: string; ms: number | null };
export type TunnelMode = 'quick' | 'managed-remote' | 'managed-local';
export type ApiTunnelMode = TunnelMode;

export interface ManagedRemoteTunnelPreset {
  id: string;
  name: string;
  hostname: string;
}

export interface TunnelInfo {
  url: string;
  connectUrl: string | null;
  bootstrapExpiresAt: number | null;
}

export interface TunnelSessionRecord {
  sessionId: string;
  mode: TunnelMode | null;
  status: 'active' | 'inactive';
  inactiveReason?: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  publicUrl?: string | null;
}

export interface RenderedTunnelSessionRecord extends TunnelSessionRecord {
  isActive: boolean;
  mode: TunnelMode;
  remainingTextForSession: string;
  inactiveLabel: string;
}

export interface TunnelStatusResponse {
  active: boolean;
  url: string | null;
  mode?: ApiTunnelMode;
  hasManagedRemoteTunnelToken?: boolean;
  managedRemoteTunnelHostname?: string | null;
  hasBootstrapToken?: boolean;
  bootstrapExpiresAt?: number | null;
  managedRemoteTunnelTokenPresetIds?: string[];
  managedRemoteTunnelPresets?: ManagedRemoteTunnelPreset[];
  activeTunnelMode?: ApiTunnelMode | null;
  providerMetadata?: {
    configPath?: string | null;
    resolvedHostname?: string | null;
  };
  activeSessions?: TunnelSessionRecord[];
  localPort?: number;
  policy?: string;
  ttlConfig?: {
    bootstrapTtlMs?: number | null;
    sessionTtlMs?: number;
  };
}

export interface TunnelStartResponse {
  ok?: boolean;
  error?: string;
  url?: string;
  connectUrl?: string | null;
  bootstrapExpiresAt?: number | null;
  activeTunnelMode?: ApiTunnelMode | null;
  mode?: ApiTunnelMode;
  activeSessions?: TunnelSessionRecord[];
  managedRemoteTunnelTokenPresetIds?: string[];
  localPort?: number;
  replacedTunnel?: boolean;
  revokedBootstrapCount?: number;
  invalidatedSessionCount?: number;
}

export interface TunnelProviderModeDescriptor {
  key: TunnelMode;
  label: string;
}

export interface TunnelProviderCapability {
  provider: string;
  modes?: TunnelProviderModeDescriptor[];
}

export interface TunnelCheckResponse {
  available?: boolean;
  provider?: string | null;
  version?: string | null;
  dependency?: string | null;
  installCommand?: string | null;
  platform?: string | null;
}

export interface TunnelDependencyInstallInfo {
  provider: string;
  dependency: string;
  installCommand: string;
}
