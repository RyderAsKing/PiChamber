import type { ServerPlatformMetadata } from './serverPlatformIcon';

type ServerVersionInfo = ServerPlatformMetadata & {
  pichamberVersion?: unknown;
};

export const displayServerPlatform = (metadata: ServerVersionInfo | null): string => {
  if (metadata?.deploymentKind === 'docker') return 'Docker';
  if (metadata?.serverPlatform === 'win32') return 'Windows';
  if (metadata?.serverPlatform === 'darwin') return 'macOS';
  if (metadata?.serverPlatform === 'linux') {
    if (typeof metadata.serverDistribution === 'string' && metadata.serverDistribution.trim()) {
      const names: Record<string, string> = {
        ubuntu: 'Ubuntu',
        arch: 'Arch Linux',
        nixos: 'NixOS',
        fedora: 'Fedora',
        debian: 'Debian',
        centos: 'CentOS',
      };
      return names[metadata.serverDistribution] ?? 'Linux';
    }
    return 'Linux';
  }
  return 'Server';
};
