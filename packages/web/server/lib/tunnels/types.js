export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';
export const TUNNEL_PROVIDER_NGROK = 'ngrok';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';

export const TUNNEL_INTENT_EPHEMERAL_PUBLIC = 'ephemeral-public';
export const TUNNEL_INTENT_PERSISTENT_PUBLIC = 'persistent-public';

export class TunnelServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TunnelServiceError';
  }
}
