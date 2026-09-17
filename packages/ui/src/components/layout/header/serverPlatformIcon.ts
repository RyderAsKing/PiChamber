import type { IconName } from '@/components/icon/icons';

export type ServerPlatformMetadata = {
  deploymentKind?: unknown;
  serverPlatform?: unknown;
  serverDistribution?: unknown;
};

export type ServerPlatformIcon = {
  name: IconName;
  color?: string;
};

const platformIconNames: Record<string, IconName> = {
  docker: 'docker',
  windows: 'windows',
  ubuntu: 'ubuntu-fill',
  arch: 'arch-linux',
  nixos: 'nixos',
  fedora: 'fedora',
  debian: 'debian',
  centos: 'centos-fill',
  linux: 'terminal-box',
  darwin: 'apple',
  unknown: 'server',
};

export function serverPlatformIcon(metadata: ServerPlatformMetadata | null): ServerPlatformIcon {
  if (metadata?.deploymentKind === 'docker') return { name: platformIconNames.docker, color: '#2496ED' };
  if (metadata?.serverPlatform === 'win32') return { name: platformIconNames.windows, color: '#0078D4' };
  if (metadata?.serverPlatform === 'linux') {
    if (metadata.serverDistribution === 'ubuntu') return { name: platformIconNames.ubuntu, color: '#E95420' };
    if (metadata.serverDistribution === 'arch') return { name: platformIconNames.arch, color: '#1793D1' };
    if (metadata.serverDistribution === 'nixos') return { name: platformIconNames.nixos, color: '#5277C3' };
    if (metadata.serverDistribution === 'fedora') return { name: platformIconNames.fedora, color: '#51A2DA' };
    if (metadata.serverDistribution === 'debian') return { name: platformIconNames.debian, color: '#A81D33' };
    if (metadata.serverDistribution === 'centos') return { name: platformIconNames.centos, color: '#932279' };
    return { name: platformIconNames.linux };
  }
  if (metadata?.serverPlatform === 'darwin') return { name: platformIconNames.darwin };
  return { name: platformIconNames.unknown };
}
