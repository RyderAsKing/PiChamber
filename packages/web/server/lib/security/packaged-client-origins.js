// Origins of packaged (non-browser) clients whose WebView origin never matches
// the server host. Keep this list identical for CORS and WebSocket origin gates:
// Android Capacitor uses androidScheme 'https' and therefore reports
// 'https://localhost' (no port). Missing that origin 403s WebSockets and, for
// CORS, makes every LAN fetch from the Android app look like "unreachable".
export const PACKAGED_CLIENT_ORIGINS = new Set([
  'pichamber-ui://app',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
]);
