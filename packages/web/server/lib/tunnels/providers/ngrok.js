import {
  checkNgrokApiReachability,
  checkNgrokAuthtokenConfigured,
  checkNgrokAvailable,
  startNgrokQuickTunnel,
} from '../../ngrok-tunnel.js';

import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_NGROK,
  TunnelServiceError,
} from '../types.js';
import { getTunnelDependencyInstallInfo } from '../install-help.js';

export const ngrokTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_NGROK,
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
      stability: 'beta',
    },
  ],
};
