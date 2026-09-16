import type {
  ApnsTokenPayload,
  PushAPI,
  PushSubscribePayload,
  PushUnsubscribePayload,
} from '@pichamber/ui/lib/api/types';
import { runtimeFetch } from '@pichamber/ui/lib/runtime-fetch';

const request = async <T>(path: string, init?: RequestInit): Promise<T | null> => {
  const response = await runtimeFetch(path, init);
  if (!response.ok) return null;
  return await response.json() as T;
};

const jsonInit = (method: 'POST' | 'DELETE', body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const createWebPushAPI = (): PushAPI => ({
  getVapidPublicKey: () => request<{ publicKey: string }>('/api/push/vapid-public-key'),
  subscribe: (payload: PushSubscribePayload) => request<{ ok: true }>('/api/push/subscribe', jsonInit('POST', payload)),
  unsubscribe: (payload: PushUnsubscribePayload) => request<{ ok: true }>('/api/push/subscribe', jsonInit('DELETE', payload)),
  setVisibility: (payload) => request<{ ok: true }>('/api/push/visibility', jsonInit('POST', payload)),
  registerApnsToken: (payload: ApnsTokenPayload) => request<{ ok: true }>('/api/push/apns-token', jsonInit('POST', payload)),
  unregisterApnsToken: (payload: ApnsTokenPayload) => request<{ ok: true }>('/api/push/apns-token', jsonInit('DELETE', payload)),
});
