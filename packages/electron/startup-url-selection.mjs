export const resolveStartupUrlProbePlan = ({ development, packagedUi, skipLocalServer }) => ({
  probeHmrApi: development === true && packagedUi !== true && skipLocalServer !== true,
  probeHmrUi: development === true && packagedUi !== true,
});

export const shouldIgnoreLoopbackConnectionLimit = ({ development, packagedUi }) => (
  development !== true || packagedUi === true
);

export const resolveDesktopHostRuntimeConfig = (config) => {
  const defaultHostId = typeof config?.defaultHostId === 'string' ? config.defaultHostId : '';
  if (!defaultHostId || defaultHostId === 'local') return null;
  const host = Array.isArray(config?.hosts)
    ? config.hosts.find((entry) => entry?.id === defaultHostId)
    : null;
  const apiBaseUrl = typeof host?.apiUrl === 'string' && host.apiUrl
    ? host.apiUrl
    : typeof host?.url === 'string' && host.url && !host.url.startsWith('relay://')
      ? host.url
      : '';
  if (!apiBaseUrl) return null;
  return {
    apiBaseUrl,
    clientToken: typeof host?.clientToken === 'string' ? host.clientToken : '',
    requestHeaders: host?.requestHeaders && typeof host.requestHeaders === 'object'
      ? host.requestHeaders
      : {},
  };
};
