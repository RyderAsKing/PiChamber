import React from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { useModelPickerSectionsStore } from '@/stores/useModelPickerSectionsStore';
import type { ModelMetadata } from '@/types';
import {
  ModelPickerRowItem,
  SortableFavoriteModelRow,
  type ModelPickerEntry,
  type ModelPickerProvider,
  type SortableFavoriteHandleProps,
} from './ModelPickerRowItem';
import { createIndexSelectionStore, type IndexSelectionStore } from './indexSelectionStore';
import {
  useModelPickerFilter,
  type HiddenModel,
} from './useModelPickerFilter';
import type { ModelPickerRowTooltipLabels } from './ModelPickerRowTooltip';

export type {
  HiddenModel,
  ModelPickerEntry,
  ModelPickerProvider,
};

const STICKY_HEADER_OFFSET = 32;

const scrollIntoView = (container: HTMLElement | null, node: HTMLElement | null) => {
  if (!node) return;
  if (!container) {
    node.scrollIntoView({ block: 'nearest' });
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const top = nodeRect.top - containerRect.top + container.scrollTop;
  const bottom = top + nodeRect.height;
  const viewTop = container.scrollTop;
  const viewBottom = viewTop + container.clientHeight;
  const viewTopWithHeader = viewTop + STICKY_HEADER_OFFSET;
  const target = top < viewTopWithHeader
    ? top - STICKY_HEADER_OFFSET
    : bottom > viewBottom
      ? bottom - container.clientHeight
      : viewTop;
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.max(0, Math.min(target, max));
};

export interface ModelPickerListLabels extends ModelPickerRowTooltipLabels {
  searchPlaceholder: string;
  noResults: string;
  favorites: string;
  recent: string;
  notSelected?: string;
  favorite?: string;
  unfavorite?: string;
}

export interface ModelPickerListProps {
  providers: ModelPickerProvider[];
  favoriteModels: ModelPickerEntry[];
  recentModels: ModelPickerEntry[];
  modelsMetadata: Map<string, ModelMetadata>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSelect: (entry: ModelPickerEntry) => void;
  labels: ModelPickerListLabels;
  selectedModel?: { providerID: string; modelID: string } | null;
  hiddenModels?: HiddenModel[];
  allowedProviderIds?: string[];
  isModelAllowed?: (providerID: string, modelID: string) => boolean;
  includeNotSelected?: boolean;
  onSelectNone?: () => void;
  selectionCount?: (entry: ModelPickerEntry) => number;
  disabled?: boolean;
  maxHeightClassName?: string;
  maxHeightStyle?: React.CSSProperties;
  sectionHeaderClassName?: string;
  rowClassName?: string;
  stickyHeaders?: boolean;
  autoFocus?: boolean;
  onEscape?: () => void;
  isFavorite?: (entry: ModelPickerEntry) => boolean;
  onToggleFavorite?: (entry: ModelPickerEntry) => void;
  renderRowEnd?: (entry: ModelPickerEntry, state: { isHighlighted: boolean; isSelected: boolean }) => React.ReactNode;
  onActiveKeyDown?: (event: React.KeyboardEvent, entry: ModelPickerEntry | undefined) => void;
  onActiveEntryChange?: (entry: ModelPickerEntry | undefined) => void;
  onVariantKey?: (event: React.KeyboardEvent, entry: ModelPickerEntry) => boolean;
  onReorderFavorite?: (active: ModelPickerEntry, over: ModelPickerEntry) => void;
  reorderFavoriteAriaLabel?: string;
  reorderFavoriteTitle?: string;
  renderVersion?: number;
  tooltipsEnabled?: boolean;
}

export const ModelPickerList: React.FC<ModelPickerListProps> = ({
  providers,
  favoriteModels,
  recentModels,
  modelsMetadata,
  searchQuery,
  onSearchQueryChange,
  onSelect,
  labels,
  selectedModel,
  hiddenModels = [],
  allowedProviderIds,
  isModelAllowed,
  includeNotSelected = false,
  onSelectNone,
  selectionCount,
  disabled = false,
  maxHeightClassName = 'max-h-[min(400px,calc(100dvh-12rem))] flex-1',
  maxHeightStyle,
  sectionHeaderClassName,
  rowClassName,
  stickyHeaders = true,
  autoFocus = true,
  onEscape,
  isFavorite,
  onToggleFavorite,
  renderRowEnd,
  onActiveKeyDown,
  onActiveEntryChange,
  onVariantKey,
  onReorderFavorite,
  reorderFavoriteAriaLabel,
  reorderFavoriteTitle,
  renderVersion,
  tooltipsEnabled = true,
}) => {
  const selectionStoreRef = React.useRef<IndexSelectionStore | null>(null);
  if (!selectionStoreRef.current) selectionStoreRef.current = createIndexSelectionStore();
  const selectionStore = selectionStoreRef.current;
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = React.useRef<HTMLElement | null>(null);
  const keyboardOwnsSelectionRef = React.useRef(false);
  const lastMousePositionRef = React.useRef<{ x: number; y: number } | null>(null);
  const collapsedRecord = useModelPickerSectionsStore((state) => state.collapsedSections);
  const toggleSection = useModelPickerSectionsStore((state) => state.toggleSection);
  const collapsedSections = React.useMemo(
    () => new Set(Object.keys(collapsedRecord).filter((key) => collapsedRecord[key])),
    [collapsedRecord],
  );
  const favoriteRowSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const {
    filteredFavorites,
    filteredRecents,
    filteredProviders,
    flatModelList,
    favoriteLookup,
    syncStickyFade,
    blockStickyFadeInteraction,
  } = useModelPickerFilter({
    providers,
    favoriteModels,
    recentModels,
    searchQuery,
    hiddenModels,
    allowedProviderIds,
    isModelAllowed,
    stickyHeaders,
    scrollRef,
    collapsedSections,
  });

  const hasResults = flatModelList.length > 0;
  const favoriteSortingEnabled = Boolean(onReorderFavorite) && searchQuery.trim().length === 0 && filteredFavorites.length > 1;

  React.useEffect(() => {
    selectionStore.set(0);
  }, [searchQuery, selectionStore]);

  const selectIndex = React.useCallback((index: number) => {
    selectionStore.set(index);
    onActiveEntryChange?.(flatModelList[index]);
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  const moveSelection = React.useCallback((direction: 1 | -1) => {
    const total = flatModelList.length;
    if (total === 0) return;
    keyboardOwnsSelectionRef.current = true;
    lastMousePositionRef.current = null;
    const currentIndex = selectionStore.getSnapshot();
    const nextIndex = (currentIndex + direction + total) % total;
    selectionStore.set(nextIndex);
    onActiveEntryChange?.(flatModelList[nextIndex]);
    requestAnimationFrame(() => scrollIntoView(scrollRef.current, itemRefs.current[nextIndex]));
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  React.useEffect(() => {
    onActiveEntryChange?.(flatModelList[selectionStore.getSnapshot()]);
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    event.stopPropagation();
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const selected = flatModelList[selectionStore.getSnapshot()];
      if (selected && onVariantKey?.(event, selected)) return;
    }
    onActiveKeyDown?.(event, flatModelList[selectionStore.getSnapshot()]);
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = flatModelList[selectionStore.getSnapshot()];
      if (selected && !disabled) onSelect(selected);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape?.();
    }
  }, [disabled, flatModelList, moveSelection, onActiveKeyDown, onEscape, onSelect, onVariantKey, selectionStore]);

  const headerClassName = cn(
    'typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 px-2 py-1.5',
    stickyHeaders && 'sticky top-0 z-20',
    sectionHeaderClassName,
  );

  let currentFlatIndex = 0;

  const renderRow = (
    entry: ModelPickerEntry,
    keyPrefix: string,
    showProviderLogo: boolean,
    rowIndex: number,
    dragHandleProps?: SortableFavoriteHandleProps | null,
  ) => (
    <ModelPickerRowItem
      key={`${keyPrefix}-${entry.providerID}-${entry.modelID}`}
      entry={entry}
      keyPrefix={keyPrefix}
      showProviderLogo={showProviderLogo}
      rowIndex={rowIndex}
      dragHandleProps={dragHandleProps}
      selectionStore={selectionStore}
      modelsMetadata={modelsMetadata}
      selectedModel={selectedModel}
      disabled={disabled}
      rowClassName={rowClassName}
      renderVersion={renderVersion}
      tooltipsEnabled={tooltipsEnabled}
      labels={labels}
      selectionCount={selectionCount}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
      onSelect={onSelect}
      selectIndex={selectIndex}
      itemRefs={itemRefs}
      lastMousePositionRef={lastMousePositionRef}
      keyboardOwnsSelectionRef={keyboardOwnsSelectionRef}
      reorderFavoriteAriaLabel={reorderFavoriteAriaLabel}
      reorderFavoriteTitle={reorderFavoriteTitle}
      renderRowEnd={renderRowEnd}
    />
  );

  const handleFavoriteDragEnd = (event: DragEndEvent) => {
    if (!onReorderFavorite) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeFavorite = favoriteLookup.get(String(active.id));
    const overFavorite = favoriteLookup.get(String(over.id));
    if (!activeFavorite || !overFavorite) return;

    onReorderFavorite(activeFavorite, overFavorite);
  };

  const isSectionCollapsed = (key: string) => collapsedSections.has(key);
  const toggleSectionCollapsed = (key: string) => toggleSection(key);

  const renderSectionHeader = (key: string, icon: React.ReactNode, label: React.ReactNode) => {
    const collapsed = isSectionCollapsed(key);
    const toggleKeyDown = (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleSectionCollapsed(key);
      }
    };

    return (
      <button
        type="button"
        aria-expanded={!collapsed}
        data-model-picker-sticky-header={stickyHeaders ? 'true' : undefined}
        className={cn(headerClassName, 'w-full text-left')}
        onClick={() => toggleSectionCollapsed(key)}
        onKeyDown={toggleKeyDown}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground">
          <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-4" />
        </span>
      </button>
    );
  };

  const renderProviderSections = () => {
    return filteredProviders.map((provider) => {
      const isCollapsed = isSectionCollapsed(`provider:${provider.id}`);

      return (
        <div
          key={provider.id}
          className="relative overflow-hidden"
        >
          {renderSectionHeader(
            `provider:${provider.id}`,
            <ProviderLogo providerId={provider.id} className="h-3.5 w-3.5 flex-shrink-0" />,
            provider.name || provider.id,
          )}
          {!isCollapsed ? (
            <div className="space-y-0.5 mt-0.5">
              {provider.models.map((model) => {
                const entry: ModelPickerEntry = { model, providerID: provider.id, modelID: model.id as string };
                const rowIndex = currentFlatIndex;
                currentFlatIndex += 1;
                return renderRow(entry, provider.id, false, rowIndex);
              })}
            </div>
          ) : null}
        </div>
      );
    });
  };

  return (
    <div className="flex flex-col min-h-0">
      <div className="p-2 border-b">
        <Input
          placeholder={labels.searchPlaceholder}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          className="h-8 typography-meta"
        />
      </div>

      <div
        className="relative flex flex-col min-h-0"
        onMouseDown={blockStickyFadeInteraction}
        onPointerDown={blockStickyFadeInteraction}
      >
        <ScrollableOverlay
          ref={scrollRef}
          className={cn(maxHeightClassName, 'p-2 space-y-3 min-h-0')}
          style={maxHeightStyle}
          onScroll={(event) => {
            if (stickyHeaders) syncStickyFade(event.currentTarget);
          }}
        >
          {includeNotSelected && onSelectNone ? (
            <div className="pb-1 border-b mb-1">
              <button
                type="button"
                disabled={disabled}
                onClick={onSelectNone}
                className={cn(
                  'w-full text-left px-2 py-1.5 rounded-md typography-meta flex items-center gap-2 cursor-pointer',
                  !disabled && 'hover:bg-interactive-hover/50',
                  disabled && 'cursor-not-allowed opacity-60',
                  rowClassName,
                )}
              >
                <span className="font-medium text-muted-foreground">{labels.notSelected || 'Not Selected'}</span>
                {!selectedModel ? <Icon name="check" className="h-4 w-4 text-primary ml-auto flex-shrink-0" /> : null}
              </button>
            </div>
          ) : null}

          {filteredFavorites.length > 0 ? (
            <div className="relative overflow-hidden">

              {renderSectionHeader('favorites', <Icon name="star-fill" className="h-3.5 w-3.5 text-primary flex-shrink-0" />, labels.favorites)}
              {!isSectionCollapsed('favorites') ? (
                favoriteSortingEnabled ? (
                  <DndContext sensors={favoriteRowSensors} collisionDetection={closestCenter} onDragEnd={handleFavoriteDragEnd}>
                    <SortableContext items={filteredFavorites.map((entry) => `${entry.providerID}:${entry.modelID}`)} strategy={verticalListSortingStrategy}>
                      <div className="space-y-0.5 mt-0.5">
                        {filteredFavorites.map((entry) => {
                          const id = `${entry.providerID}:${entry.modelID}`;
                          const rowIndex = currentFlatIndex;
                          currentFlatIndex += 1;
                          return (
                            <SortableFavoriteModelRow key={`favorite-${id}`} id={id} disabled={disabled}>
                              {(dragHandleProps) => renderRow(entry, 'favorite', true, rowIndex, dragHandleProps)}
                            </SortableFavoriteModelRow>
                          );
                        })}
                      </div>
                    </SortableContext>
                  </DndContext>
                ) : (
                  <div className="space-y-0.5 mt-0.5">
                    {filteredFavorites.map((entry) => {
                      const rowIndex = currentFlatIndex;
                      currentFlatIndex += 1;
                      return renderRow(entry, 'favorite', true, rowIndex);
                    })}
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          {filteredRecents.length > 0 ? (
            <div className="relative overflow-hidden">

              {renderSectionHeader('recent', <Icon name="history" className="h-3.5 w-3.5 flex-shrink-0" />, labels.recent)}
              {!isSectionCollapsed('recent') ? (
                <div className="space-y-0.5 mt-0.5">
                  {filteredRecents.map((entry) => {
                    const rowIndex = currentFlatIndex;
                    currentFlatIndex += 1;
                    return renderRow(entry, 'recent', true, rowIndex);
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {renderProviderSections()}

          {!hasResults ? (
            <div className="p-4 text-center typography-meta text-muted-foreground">
              {labels.noResults}
            </div>
          ) : null}
        </ScrollableOverlay>
      </div>
    </div>
  );
};
