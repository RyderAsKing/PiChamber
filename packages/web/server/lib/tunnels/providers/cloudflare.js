import {
  checkCloudflareApiReachability,
  checkCloudflaredAvailable,
  inspectManagedLocalCloudflareConfig,
  normalizeCloudflareTunnelHostname,
  startCloudflareManagedLocalTunnel,
  startCloudflareManagedRemoteTunnel,
  startCloudflareQuickTunnel,
} from '../../cloudflare-tunnel.js';

import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
} from '../types.js';
import { getTunnelDependencyInstallInfo } from '../install-help.js';

export const cloudflareTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_CLOUDFLARE,
  defaults: {
    mode: TUNNEL_MODE_QUICK,
    optionDefaults: {},
  },
  modes: [
    {
      key: TUNNEL_MODE_QUICK,
      label: 'Quick Tunnel',
      intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC,
      requires: [],
      supports: ['sessionTTL'],
      stability: 'ga',
    },
    {
      key: TUNNEL_MODE_MANAGED_REMOTE,
      label: 'Managed Remote Tunnel',
      intent: TUNNEL_INTENT_PERSISTENT_PUBLIC,
      requires: ['token', 'hostname'],
      supports: ['customDomain', 'sessionTTL'],
      stability: 'ga',
    },
    {
      key: TUNNEL_MODE_MANAGED_LOCAL,
      label: 'Managed Local Tunnel',
      intent: TUNNEL_INTENT_PERSISTENT_PUBLIC,
      requires: [],
      supports: ['configFile', 'customDomain', 'sessionTTL'],
      stability: 'ga',
    },
  ],
};
