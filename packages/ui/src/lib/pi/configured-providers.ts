/** Selection catalogs only include providers with working credentials and models. */
export const isConfiguredProvider = (provider: {
  authenticated?: boolean;
  models?: unknown;
}): boolean => {
  if (provider.authenticated !== true) return false;
  const models = provider.models;
  if (Array.isArray(models)) return models.length > 0;
  if (models && typeof models === 'object') return Object.keys(models).length > 0;
  return false;
};

export const configuredProviders = <T extends { authenticated?: boolean; models?: unknown }>(
  providers: readonly T[],
): T[] => providers.filter(isConfiguredProvider);
