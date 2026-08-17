const parseProviderModelString = (value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const separator = trimmed.indexOf('/');
  if (separator <= 0 || separator >= trimmed.length - 1) return undefined;
  const providerId = trimmed.slice(0, separator).trim();
  const modelId = trimmed.slice(separator + 1).trim();
  if (!providerId || !modelId) return undefined;
  return { providerId, modelId };
};

/**
 * Copy leftover UI/desktop model strings into sidecar fields that are still unset.
 * Sessions settings now owns these fields; this is a one-time bridge.
 */
export const legacyUiModelDefaultsPatch = (uiSettings, current = {}) => {
  if (!uiSettings || typeof uiSettings !== 'object') return {};
  const patch = {};
  if (!current.defaultModel) {
    const model = parseProviderModelString(uiSettings.defaultModel);
    if (model) patch.defaultModel = model;
  }
  if (!current.smallModel && uiSettings.smallModelUseDefault === false) {
    const small = parseProviderModelString(uiSettings.smallModelOverride);
    if (small) patch.smallModel = small;
  }
  if (!current.walkthroughModel) {
    const walkthrough = parseProviderModelString(uiSettings.walkthroughModelOverride);
    if (walkthrough) patch.walkthroughModel = walkthrough;
  }
  return patch;
};

const LEGACY_UI_MODEL_DEFAULT_CLEAR = {
  defaultModel: '',
  smallModelOverride: '',
  walkthroughModelOverride: '',
};

export const adoptLegacyUiModelDefaults = async (settingsStore, uiSettingsStore) => {
  const current = await settingsStore.read();
  let uiSettings;
  try {
    uiSettings = await uiSettingsStore.read();
  } catch {
    return current;
  }
  const patch = legacyUiModelDefaultsPatch(uiSettings, current);
  if (Object.keys(patch).length === 0) return current;
  const next = await settingsStore.update(patch);
  try {
    await uiSettingsStore.write(LEGACY_UI_MODEL_DEFAULT_CLEAR);
  } catch {
    // Sidecar is already authoritative; leftover UI keys must not fail the read.
  }
  return next;
};
