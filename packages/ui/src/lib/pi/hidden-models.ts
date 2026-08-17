type HiddenModelRef = { providerID: string; modelID: string };

export const isHiddenModelRef = (
  hiddenModels: readonly HiddenModelRef[],
  providerID: string,
  modelID: string,
): boolean => hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID);

/** Drops hidden models from a selection list, keeping `keep` so a saved value still renders. */
export const visibleModelOptions = <T extends { providerId: string; modelId: string }>(
  options: readonly T[],
  hiddenModels: readonly HiddenModelRef[],
  keep?: { providerId: string; modelId: string } | readonly { providerId: string; modelId: string }[] | null,
): T[] => {
  const keepList = keep == null ? [] : Array.isArray(keep) ? keep : [keep];
  return options.filter((option) => {
    if (keepList.some((item) => item.providerId === option.providerId && item.modelId === option.modelId)) {
      return true;
    }
    return !isHiddenModelRef(hiddenModels, option.providerId, option.modelId);
  });
};
