import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { parsePiThinkingLevel } from '@/lib/pi/thinking';
import type { PiThinkingLevel } from '@/lib/pi/types';
import type { ModelMetadata } from '@/types';
import { cn } from '@/lib/utils';
import { formatEffortLabel } from '../mobileControlsUtils';
import { formatTokens, getCapabilityIcons, getModalityIcons } from '../modelControlsMetadata';
import { ThinkingLevelPicker } from '../ThinkingLevelControl';

export type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

const buildModelRefKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`;

export interface MobileModelPickerPanelProps {
  open: boolean;
  onClose: () => void;
  mobileModelQuery: string;
  onMobileModelQueryChange: (query: string) => void;
  filteredFavorites: Array<{ model: ProviderModel; providerID: string; modelID: string }>;
  filteredRecents: Array<{ model: ProviderModel; providerID: string; modelID: string }>;
  filteredProviders: Array<{
    provider: { id?: string; name?: string };
    providerModels: ProviderModel[];
    matchesProvider: boolean;
  }>;
  expandedMobileProviders: Set<string>;
  onToggleMobileProviderExpansion: (providerId: string) => void;
  expandedMobileModelKey: string | null;
  onToggleExpandedMobileModelKey: (key: string | null) => void;
  currentProviderId?: string;
  currentModelId?: string;
  getModelDisplayName: (model: ProviderModel) => string;
  getModelMetadata: (providerId: string, modelId: string) => ModelMetadata | undefined;
  getModelVariantOptions: (providerId: string, modelId: string) => readonly PiThinkingLevel[];
  resolveModelVariantSelection: (providerId: string, modelId: string) => string | undefined;
  pendingThinkingVariants: Map<string, string | undefined>;
  onUpdatePendingThinkingVariant: (rowKey: string, next: string | undefined) => void;
  isFavoriteModel: (providerId: string, modelId: string) => boolean;
  onToggleFavoriteModel: (providerId: string, modelId: string) => void;
  onApplyModel: (providerId: string, modelId: string, variant: string | undefined) => void;
}

export const MobileModelPickerPanel: React.FC<MobileModelPickerPanelProps> = ({
  open,
  onClose,
  mobileModelQuery,
  onMobileModelQueryChange,
  filteredFavorites,
  filteredRecents,
  filteredProviders,
  expandedMobileProviders,
  onToggleMobileProviderExpansion,
  expandedMobileModelKey,
  onToggleExpandedMobileModelKey,
  currentProviderId,
  currentModelId,
  getModelDisplayName,
  getModelMetadata,
  getModelVariantOptions,
  resolveModelVariantSelection,
  pendingThinkingVariants,
  onUpdatePendingThinkingVariant,
  isFavoriteModel,
  onToggleFavoriteModel,
  onApplyModel,
}) => {
  if (!open) return null;

  const normalizedQuery = mobileModelQuery.trim();
  const hasResults =
    filteredFavorites.length > 0 || filteredRecents.length > 0 || filteredProviders.length > 0;

  const renderMobileModelRow = ({
    model,
    providerId,
    modelId,
    showProviderLogo,
  }: {
    model: ProviderModel;
    providerId: string;
    modelId: string;
    showProviderLogo: boolean;
  }) => {
    const rowKey = buildModelRefKey(providerId, modelId);
    const isSelected = providerId === currentProviderId && modelId === currentModelId;
    const metadata = mergeModelMetadataWithLiveModel(
      providerId,
      model,
      getModelMetadata(providerId, modelId),
    );
    const variantOptions = getModelVariantOptions(providerId, modelId);
    const hasVariants = variantOptions.length > 0;
    const resolvedVariant = resolveModelVariantSelection(providerId, modelId);
    const pendingVariant = pendingThinkingVariants.get(rowKey);
    const hasPendingForRow = pendingThinkingVariants.has(rowKey);
    const effectiveVariant = hasPendingForRow ? pendingVariant : resolvedVariant;
    const variantLabel = hasVariants ? formatEffortLabel(effectiveVariant) : null;
    const isExpanded = expandedMobileModelKey === rowKey;
    const capabilityIcons = getCapabilityIcons(metadata);
    const modalityIcons = [
      ...getModalityIcons(metadata, 'input'),
      ...getModalityIcons(metadata, 'output'),
    ];
    const indicatorIcons = Array.from(
      new Map([...capabilityIcons, ...modalityIcons].map((icon) => [icon.key, icon])).values(),
    );
    const contextText = metadata?.limit?.context
      ? `${formatTokens(metadata.limit.context)} ctx`
      : null;

    return (
      <div
        key={`mobile-model-${providerId}-${modelId}`}
        className={cn(
          'border-b border-border/30 last:border-b-0',
          isSelected && 'bg-interactive-selection/15 text-interactive-selection-foreground',
        )}
      >
        <div className="flex items-center gap-2 px-2 py-1.5">
          <button
            type="button"
            onClick={() => onApplyModel(providerId, modelId, effectiveVariant)}
            className={cn(
              'flex flex-1 min-w-0 items-start gap-2 text-left',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded-lg',
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                {showProviderLogo ? (
                  <ProviderLogo providerId={providerId} className="size-3.5 flex-shrink-0" />
                ) : null}
                <span className="typography-meta font-medium text-foreground truncate">
                  {getModelDisplayName(model)}
                </span>
                {isSelected ? (
                  <Icon name="check" className="size-4 flex-shrink-0 text-primary" />
                ) : null}
              </div>
              {contextText || indicatorIcons.length > 0 ? (
                <div className="flex min-w-0 items-center gap-1.5 overflow-hidden typography-micro text-muted-foreground">
                  {contextText ? (
                    <span className="whitespace-nowrap flex-shrink-0">{contextText}</span>
                  ) : null}
                  {contextText && indicatorIcons.length > 0 ? (
                    <span aria-hidden="true" className="h-3 w-px flex-shrink-0 bg-border/50" />
                  ) : null}
                  {indicatorIcons.length > 0 ? (
                    <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap pl-0.5">
                      {indicatorIcons.map(({ key, icon: iconName, label }) => (
                        <span
                          key={`meta-${providerId}-${modelId}-${key}`}
                          className="flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground"
                          title={label}
                          aria-label={label}
                        >
                          <Icon name={iconName} className="size-3" />
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </button>
          {hasVariants ? (
            <button
              type="button"
              onClick={() =>
                onToggleExpandedMobileModelKey(expandedMobileModelKey === rowKey ? null : rowKey)
              }
              className="flex items-center gap-0.5 typography-micro font-medium text-muted-foreground hover:text-foreground flex-shrink-0"
              aria-expanded={isExpanded}
              aria-label={isExpanded ? 'Hide thinking modes' : 'Show thinking modes'}
            >
              <span className="whitespace-nowrap">{variantLabel}</span>
              {isExpanded ? (
                <Icon name="arrow-down-s" className="size-3.5" />
              ) : (
                <Icon name="arrow-right-s" className="size-3.5" />
              )}
            </button>
          ) : null}
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleFavoriteModel(providerId, modelId);
              }}
              className={cn(
                'model-favorite-button flex size-5 items-center justify-center hover:text-primary/80 flex-shrink-0',
                isFavoriteModel(providerId, modelId) ? 'text-primary' : 'text-muted-foreground',
              )}
              aria-label={isFavoriteModel(providerId, modelId) ? 'Unfavorite' : 'Favorite'}
              title={
                isFavoriteModel(providerId, modelId)
                  ? 'Remove from favorites'
                  : 'Add to favorites'
              }
            >
              {isFavoriteModel(providerId, modelId) ? (
                <Icon name="star-fill" className="size-4" />
              ) : (
                <Icon name="star" className="size-4" />
              )}
            </button>
          </div>
        </div>
        {isExpanded && hasVariants ? (
          <div className="border-t border-border/30 px-1 py-1" data-no-drawer-swipe="true">
            <ThinkingLevelPicker
              levels={variantOptions}
              value={parsePiThinkingLevel(effectiveVariant) ?? undefined}
              onChange={() => {}}
              onCommit={(next) => onUpdatePendingThinkingVariant(rowKey, next as string | undefined)}
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <MobileOverlayPanel open={true} onClose={onClose} title="Select model">
      <div className="flex flex-col gap-2">
        <div>
          <div className="relative">
            <Icon
              name="search"
              className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
            />
            <Input
              value={mobileModelQuery}
              onChange={(event) => {
                onMobileModelQueryChange(event.target.value);
                onToggleExpandedMobileModelKey(null);
              }}
              placeholder="Search providers or models"
              className="pl-7 h-9 rounded-xl border-border/40 bg-[var(--surface-elevated)] typography-meta"
            />
            {mobileModelQuery && (
              <button
                type="button"
                onClick={() => {
                  onMobileModelQueryChange('');
                  onToggleExpandedMobileModelKey(null);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <Icon name="close-circle" className="size-4" />
              </button>
            )}
          </div>
        </div>

        {!hasResults && (
          <div className="px-3 py-8 text-center typography-meta text-muted-foreground">
            No providers or models match your search.
          </div>
        )}

        {/* Favorites Section for Mobile */}
        {filteredFavorites.length > 0 && (
          <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <Icon name="star-fill" className="size-3 inline-block mr-1.5 text-primary" />
              Favorites
            </div>
            <div className="flex flex-col border-t border-border/30">
              {filteredFavorites.map(({ model, providerID, modelID }) =>
                renderMobileModelRow({
                  model,
                  providerId: providerID,
                  modelId: modelID,
                  showProviderLogo: true,
                }),
              )}
            </div>
          </div>
        )}

        {/* Recent Section for Mobile */}
        {filteredRecents.length > 0 && (
          <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <Icon name="time" className="size-3 inline-block mr-1.5" />
              Recent
            </div>
            <div className="flex flex-col border-t border-border/30">
              {filteredRecents.map(({ model, providerID, modelID }) =>
                renderMobileModelRow({
                  model,
                  providerId: providerID,
                  modelId: modelID,
                  showProviderLogo: true,
                }),
              )}
            </div>
          </div>
        )}

        {filteredProviders.map(({ provider, providerModels }) => {
          if (providerModels.length === 0) {
            return null;
          }

          const providerId = String(provider.id || '');
          const providerName = String(provider.name || providerId);
          const isActiveProvider = providerId === currentProviderId;
          const isExpanded =
            expandedMobileProviders.has(providerId) || normalizedQuery.length > 0;

          return (
            <div
              key={providerId}
              className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden"
            >
              <button
                type="button"
                onClick={() => {
                  if (normalizedQuery.length > 0) {
                    return;
                  }
                  onToggleMobileProviderExpansion(providerId);
                }}
                className="flex w-full items-center justify-between gap-1.5 px-2 py-1.5 text-left"
                aria-expanded={isExpanded}
              >
                <div className="flex items-center gap-2">
                  <ProviderLogo providerId={providerId} className="size-3.5" />
                  <span className="typography-meta font-medium text-foreground">
                    {providerName}
                  </span>
                  {isActiveProvider && (
                    <span className="typography-micro text-primary/80">Current</span>
                  )}
                </div>
                {isExpanded ? (
                  <Icon name="arrow-down-s" className="size-3 text-muted-foreground" />
                ) : (
                  <Icon name="arrow-right-s" className="size-3 text-muted-foreground" />
                )}
              </button>

              {isExpanded && providerModels.length > 0 && (
                <div className="flex flex-col border-t border-border/30">
                  {providerModels.map((model: ProviderModel) =>
                    renderMobileModelRow({
                      model,
                      providerId: String(provider.id || ''),
                      modelId: String(model.id || ''),
                      showProviderLogo: false,
                    }),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </MobileOverlayPanel>
  );
};
