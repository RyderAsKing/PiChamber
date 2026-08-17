import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useModelLists } from '@/hooks/useModelLists';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

const MODEL_PICKER_LABELS = {
  searchPlaceholder: 'Search models',
  noResults: 'No models found',
  favorites: 'Favorites',
  recent: 'Recent',
  keyboardHint: '↑↓ navigate',
  favorite: 'Favorite',
  unfavorite: 'Unfavorite',
  capabilities: 'Capabilities',
  capabilityToolCalling: 'Tool calling',
  capabilityReasoning: 'Reasoning',
  input: 'Input',
  output: 'Output',
  costPerMillion: 'Cost ($/1M tokens)',
};

type SettingsModelPickerValue = { providerId: string; modelId: string };

type SettingsModelPickerProps = {
  value?: SettingsModelPickerValue | null;
  noneLabel: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  isModelAllowed?: (providerID: string, modelID: string) => boolean;
  onChange: (model: SettingsModelPickerValue | null) => void;
};

/** Settings-sized trigger that opens the shared model picker. */
export const SettingsModelPicker: React.FC<SettingsModelPickerProps> = ({
  value,
  noneLabel,
  ariaLabel,
  disabled = false,
  className,
  isModelAllowed,
  onChange,
}) => {
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const providerOrder = useUIStore((state) => state.providerOrder);
  const setProviderOrder = useUIStore((state) => state.setProviderOrder);
  const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
  const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
  const reorderFavoriteModel = useUIStore((state) => state.reorderFavoriteModel);
  const { favoriteModelsList, recentModelsList } = useModelLists();
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');

  React.useEffect(() => {
    if (!open) setSearchQuery('');
  }, [open]);

  const selectedProvider = value
    ? providers.find((provider) => provider.id === value.providerId)
    : undefined;
  const selectedModel = value && selectedProvider
    ? (Array.isArray(selectedProvider.models) ? selectedProvider.models : []).find((model) => model.id === value.modelId)
    : undefined;
  const selectedLabel = value
    ? getModelDisplayName(selectedModel, value.modelId)
    : noneLabel;

  const pickerHiddenModels = React.useMemo(() => {
    if (!value) return hiddenModels;
    return hiddenModels.filter(
      (item) => !(item.providerID === value.providerId && item.modelID === value.modelId),
    );
  }, [hiddenModels, value]);

  const handleSelect = React.useCallback((entry: ModelPickerEntry) => {
    onChange({ providerId: entry.providerID, modelId: entry.modelID });
    setOpen(false);
  }, [onChange]);

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={(nextOpen) => { if (!disabled) setOpen(nextOpen); }}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            dropdownTriggerVariants({ size: 'default' }),
            SETTINGS_SELECT_ROW_TRIGGER_CLASS,
            'min-w-0',
            className,
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {value?.providerId ? (
              <ProviderLogo providerId={value.providerId} className="size-4 shrink-0" />
            ) : null}
            <span className={cn('truncate', value ? 'text-foreground' : 'text-muted-foreground')}>
              {selectedLabel}
            </span>
          </span>
          <Icon name="arrow-down-s" className="size-4 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        portalToBody
        positionerClassName="z-[80]"
        className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col"
      >
        <ModelPickerList
          providers={providers as ModelPickerProvider[]}
          favoriteModels={favoriteModelsList}
          recentModels={recentModelsList}
          modelsMetadata={modelsMetadata}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onSelect={handleSelect}
          labels={{ ...MODEL_PICKER_LABELS, notSelected: noneLabel }}
          selectedModel={value ? { providerID: value.providerId, modelID: value.modelId } : null}
          hiddenModels={pickerHiddenModels}
          isModelAllowed={isModelAllowed}
          includeNotSelected
          onSelectNone={() => {
            onChange(null);
            setOpen(false);
          }}
          disabled={disabled}
          autoFocus
          onEscape={() => setOpen(false)}
          isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
          onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
          onReorderFavorite={(active, over) => reorderFavoriteModel(
            active.providerID,
            active.modelID,
            over.providerID,
            over.modelID,
          )}
          reorderFavoriteAriaLabel="Reorder favorite"
          reorderFavoriteTitle="Drag to reorder favorite"
          providerOrder={providerOrder}
          onReorderProvider={setProviderOrder}
          reorderProviderTitle="Drag to reorder provider"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
