/**
 * Shared browser UUID for web, desktop, hosted-mobile, and Capacitor.
 * Uses `crypto.randomUUID` when available, otherwise formats
 * `crypto.getRandomValues` bytes as UUID v4 for LAN HTTP pages.
 * No `Math.random` fallback; missing or failing sources throw.
 */
export const createBrowserUuid = (): string => {
  const cryptoRef = globalThis.crypto;
  if (typeof cryptoRef?.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  if (typeof cryptoRef?.getRandomValues !== 'function') {
    throw new Error('Secure random UUID is unavailable in this browser context');
  }
  const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
