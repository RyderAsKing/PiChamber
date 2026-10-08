import {
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_CLOUDFLARE,
} from '../types.js';
import { getTunnelDependencyInstallInfo } from '../install-help.js';

export const cloudflareTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_CLOUDFLARE,
  defaults: {
    mode: TUNNEL_MODE_MANAGED_REMOTE,
    optionDefaults: {},
  },
  modes: [
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
