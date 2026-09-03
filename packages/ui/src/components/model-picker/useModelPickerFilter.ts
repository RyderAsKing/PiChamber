import React from 'react';
import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerRowItem';
import { getModelDisplayName } from './modelPickerRowHelpers';

export type HiddenModel = { providerID: string; modelID: string };

const STICKY_FADE_MAX_SIZE = 48;
const STICKY_FADE_MIN_SIZE = 32;
const STICKY_FADE_CLEAR_MAX_SIZE = 24;

export interface UseModelPickerFilterOptions {
  providers: ModelPickerProvider[];
  favoriteModels: ModelPickerEntry[];
  recentModels: ModelPickerEntry[];
  searchQuery: string;
  hiddenModels?: HiddenModel[];
  allowedProviderIds?: string[];
  isModelAllowed?: (providerID: string, modelID: string) => boolean;
  stickyHeaders?: boolean;
  scrollRef: React.MutableRefObject<HTMLElement | null>;
  collapsedSections: Set<string>;
}

export function useModelPickerFilter({
  providers,
  favoriteModels,
  recentModels,
  searchQuery,
  hiddenModels = [],
  allowedProviderIds,
  isModelAllowed,
  stickyHeaders = true,
  scrollRef,
  collapsedSections,
}: UseModelPickerFilterOptions) {
  const stickyFadeSizeRef = React.useRef(0);

  const allowedProviderSet = React.useMemo(() => {
    if (!allowedProviderIds) return null;
    return new Set(allowedProviderIds);
  }, [allowedProviderIds]);

  const providerById = React.useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers]
  );

  const isHidden = React.useCallback(
    (providerID: string, modelID: string) => {
      return hiddenModels.some((hidden) => hidden.providerID === providerID && hidden.modelID === modelID);
    },
    [hiddenModels]
  );

  const matchesQuery = React.useCallback(
    (modelName: string, providerName: string) => {
      const query = searchQuery.trim().toLowerCase();
      if (!query) return true;
      return modelName.toLowerCase().includes(query) || providerName.toLowerCase().includes(query);
    },
    [searchQuery]
  );

  const filteredFavorites = React.useMemo(
    () =>
      favoriteModels.filter(({ model, providerID, modelID }) => {
        if (allowedProviderSet && !allowedProviderSet.has(providerID)) return false;
        if (isModelAllowed && !isModelAllowed(providerID, modelID)) return false;
        if (isHidden(providerID, modelID)) return false;
        const providerName = providerById.get(providerID)?.name || providerID;
        return matchesQuery(getModelDisplayName(model), providerName);
      }),
    [allowedProviderSet, favoriteModels, isHidden, isModelAllowed, matchesQuery, providerById]
  );

  const filteredRecents = React.useMemo(
    () =>
      recentModels.filter(({ model, providerID, modelID }) => {
        if (allowedProviderSet && !allowedProviderSet.has(providerID)) return false;
        if (isModelAllowed && !isModelAllowed(providerID, modelID)) return false;
        if (isHidden(providerID, modelID)) return false;
        const providerName = providerById.get(providerID)?.name || providerID;
        return matchesQuery(getModelDisplayName(model), providerName);
      }),
    [allowedProviderSet, isHidden, isModelAllowed, matchesQuery, providerById, recentModels]
  );

  const filteredProviders = React.useMemo(
    () =>
      providers
        .filter((provider) => !allowedProviderSet || allowedProviderSet.has(provider.id))
        .map((provider) => {
          const models = Array.isArray(provider.models) ? provider.models : [];
          const filteredModels = models.filter((model) => {
            const modelID = typeof model.id === 'string' ? model.id : '';
            if (!modelID || isHidden(provider.id, modelID)) return false;
            if (isModelAllowed && !isModelAllowed(provider.id, modelID)) return false;
            return matchesQuery(getModelDisplayName(model), provider.name || provider.id);
          });
          return { ...provider, models: filteredModels };
        })
        .filter((provider) => provider.models.length > 0),
    [allowedProviderSet, isHidden, isModelAllowed, matchesQuery, providers]
  );

  const visibleSectionKeys = React.useMemo(
    () => [
      ...(filteredFavorites.length > 0 ? ['favorites'] : []),
      ...(filteredRecents.length > 0 ? ['recent'] : []),
      ...filteredProviders.map((provider) => `provider:${provider.id}`),
    ],
    [filteredFavorites.length, filteredProviders, filteredRecents.length]
  );

  const syncStickyFade = React.useCallback((scroller: HTMLElement) => {
    const hasTopScroll = scroller.scrollTop > 1;
    const fadeSize = hasTopScroll
      ? Math.min(STICKY_FADE_MIN_SIZE + scroller.scrollTop, STICKY_FADE_MAX_SIZE)
      : 0;
    stickyFadeSizeRef.current = fadeSize;
    scroller.style.setProperty('--scroll-shadow-top-size', `${fadeSize}px`);
    scroller.style.setProperty(
      '--scroll-shadow-top-clear-size',
      `${Math.min(Math.max(fadeSize - 8, 0), STICKY_FADE_CLEAR_MAX_SIZE)}px`
    );
  }, []);

  const blockStickyFadeInteraction = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>) => {
      if ((event.target as Element).closest('[data-overlay-scrollbar-thumb], [data-model-picker-sticky-header]')) {
        return;
      }
      const eventY = event.clientY - event.currentTarget.getBoundingClientRect().top;
      if (eventY >= stickyFadeSizeRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
    []
  );

  React.useLayoutEffect(() => {
    if (stickyHeaders && scrollRef.current) syncStickyFade(scrollRef.current);
  }, [scrollRef, stickyHeaders, syncStickyFade, visibleSectionKeys]);

  const flatModelList = React.useMemo(() => {
    const items: ModelPickerEntry[] = [];
    if (!collapsedSections.has('favorites')) filteredFavorites.forEach((entry) => items.push(entry));
    if (!collapsedSections.has('recent')) filteredRecents.forEach((entry) => items.push(entry));
    filteredProviders.forEach((provider) => {
      if (collapsedSections.has(`provider:${provider.id}`)) return;
      provider.models.forEach((model) =>
        items.push({ model, providerID: provider.id, modelID: model.id as string })
      );
    });
    return items;
  }, [collapsedSections, filteredFavorites, filteredProviders, filteredRecents]);

  const favoriteLookup: Map<string, ModelPickerEntry> = React.useMemo(
    () =>
      new Map(
        filteredFavorites.map((entry) => [`${entry.providerID}:${entry.modelID}`, entry] as const)
      ),
    [filteredFavorites]
  );

  return {
    allowedProviderSet,
    providerById,
    filteredFavorites,
    filteredRecents,
    filteredProviders,
    visibleSectionKeys,
    flatModelList,
    favoriteLookup,
    syncStickyFade,
    blockStickyFadeInteraction,
  };
}
