import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { cn } from '@/lib/utils';
import type { ModelMetadata } from '@/types';
import {
  formatModelContextTokens,
  getModelDisplayName,
  ModelPickerRowTooltip,
  type ModelPickerRowTooltipLabels,
} from './ModelPickerRowTooltip';

export type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

export type ModelPickerProvider = {
  id: string;
  name?: string;
  models?: ProviderModel[];
};

export type ModelPickerEntry = {
  model: ProviderModel;
  providerID: string;
  modelID: string;
};

export type IndexSelectionStore = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  subscribeIndex: (index: number, listener: () => void) => () => void;
  set: (value: number) => void;
};

export const createIndexSelectionStore = (initialValue = 0): IndexSelectionStore => {
  let value = initialValue;
  const listeners = new Set<() => void>();
  const indexListeners = new Map<number, Set<() => void>>();

  const notify = (index: number) => {
    const set = indexListeners.get(index);
    if (!set) return;
    for (const listener of set) listener();
  };

  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeIndex: (index, listener) => {
      let set = indexListeners.get(index);
      if (!set) {
        set = new Set();
        indexListeners.set(index, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) indexListeners.delete(index);
      };
    },
    set: (nextValue) => {
      if (value === nextValue) return;
      const previousValue = value;
      value = nextValue;
      notify(previousValue);
      notify(nextValue);
      for (const listener of listeners) listener();
    },
  };
};

export const ModelPickerRowHighlight: React.FC<{
  store: IndexSelectionStore;
  index: number;
  renderVersion?: number;
  children: (isHighlighted: boolean) => React.ReactNode;
}> = React.memo(({ store, index, children }) => {
  const [isHighlighted, setIsHighlighted] = React.useState(() => store.getSnapshot() === index);

  React.useEffect(() => {
    const sync = () => setIsHighlighted(store.getSnapshot() === index);
    sync();
    return store.subscribeIndex(index, sync);
  }, [index, store]);

  return <>{children(isHighlighted)}</>;
});

export const ModelPickerFooter: React.FC<{
  store: IndexSelectionStore;
  flatModelList: ModelPickerEntry[];
  footerContent?: React.ReactNode | ((activeEntry: ModelPickerEntry | undefined) => React.ReactNode);
  fallback: React.ReactNode;
}> = ({ store, flatModelList, footerContent, fallback }) => {
  const [selectedIndex, setSelectedIndex] = React.useState(() => store.getSnapshot());

  React.useEffect(() => store.subscribe(() => setSelectedIndex(store.getSnapshot())), [store]);

  const activeEntry = flatModelList[selectedIndex];
  return <>{typeof footerContent === 'function' ? footerContent(activeEntry) : (footerContent ?? fallback)}</>;
};

export type SortableFavoriteHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
  isDragging: boolean;
};

export const SortableFavoriteModelRow: React.FC<{
  id: string;
  disabled?: boolean;
  children: (dragHandleProps: SortableFavoriteHandleProps) => React.ReactNode;
}> = ({ id, disabled = false, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'opacity-60')}
    >
      {children({ attributes, listeners, setActivatorNodeRef, isDragging })}
    </div>
  );
};

export const SortableProviderSection: React.FC<{
  id: string;
  disabled?: boolean;
  children: (dragHandleProps: SortableFavoriteHandleProps) => React.ReactNode;
}> = ({ id, disabled = false, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
  } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: DndCSS.Translate.toString(transform),
        transition,
      }}
    >
      {children({ attributes, listeners, setActivatorNodeRef, isDragging: false })}
    </div>
  );
};

export interface ModelPickerRowItemProps {
  entry: ModelPickerEntry;
  keyPrefix: string;
  showProviderLogo: boolean;
  rowIndex: number;
  dragHandleProps?: SortableFavoriteHandleProps | null;
  selectionStore: IndexSelectionStore;
  modelsMetadata: Map<string, ModelMetadata>;
  selectedModel?: { providerID: string; modelID: string } | null;
  disabled?: boolean;
  rowClassName?: string;
  renderVersion?: number;
  tooltipsEnabled?: boolean;
  labels: ModelPickerRowTooltipLabels & {
    favorite?: string;
    unfavorite?: string;
  };
  selectionCount?: (entry: ModelPickerEntry) => number;
  isFavorite?: (entry: ModelPickerEntry) => boolean;
  onToggleFavorite?: (entry: ModelPickerEntry) => void;
  onSelect: (entry: ModelPickerEntry) => void;
  selectIndex: (index: number) => void;
  itemRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  lastMousePositionRef: React.MutableRefObject<{ x: number; y: number } | null>;
  keyboardOwnsSelectionRef: React.MutableRefObject<boolean>;
  reorderFavoriteAriaLabel?: string;
  reorderFavoriteTitle?: string;
  renderRowEnd?: (entry: ModelPickerEntry, state: { isHighlighted: boolean; isSelected: boolean }) => React.ReactNode;
}

export const ModelPickerRowItem: React.FC<ModelPickerRowItemProps> = ({
  entry,
  keyPrefix,
  showProviderLogo,
  rowIndex,
  dragHandleProps,
  selectionStore,
  modelsMetadata,
  selectedModel,
  disabled = false,
  rowClassName,
  renderVersion,
  tooltipsEnabled = true,
  labels,
  selectionCount,
  isFavorite,
  onToggleFavorite,
  onSelect,
  selectIndex,
  itemRefs,
  lastMousePositionRef,
  keyboardOwnsSelectionRef,
  reorderFavoriteAriaLabel,
  reorderFavoriteTitle,
  renderRowEnd,
}) => {
  const metadata = mergeModelMetadataWithLiveModel(
    entry.providerID,
    entry.model,
    modelsMetadata.get(`${entry.providerID}/${entry.modelID}`)
  );
  const contextTokens = formatModelContextTokens(metadata?.limit?.context);
  const count = selectionCount?.(entry) ?? 0;
  const isSelected = selectedModel?.providerID === entry.providerID && selectedModel.modelID === entry.modelID;
  const favorite = isFavorite?.(entry) ?? false;

  const handleMouseActivity = (event: React.MouseEvent) => {
    const nextPosition = { x: event.clientX, y: event.clientY };
    const previousPosition = lastMousePositionRef.current;
    const pointerMoved = !previousPosition || previousPosition.x !== nextPosition.x || previousPosition.y !== nextPosition.y;
    lastMousePositionRef.current = nextPosition;

    if (keyboardOwnsSelectionRef.current && !previousPosition) return;
    if (keyboardOwnsSelectionRef.current && !pointerMoved) return;
    if (keyboardOwnsSelectionRef.current && pointerMoved) keyboardOwnsSelectionRef.current = false;
    selectIndex(rowIndex);
  };

  return (
    <ModelPickerRowHighlight
      key={`${keyPrefix}-${entry.providerID}-${entry.modelID}`}
      store={selectionStore}
      index={rowIndex}
      renderVersion={renderVersion}
    >
      {(isHighlighted) => {
        const rowElement = (
          <div
            ref={(el) => { itemRefs.current[rowIndex] = el; }}
            role="option"
            aria-selected={isSelected}
            aria-disabled={disabled || undefined}
            tabIndex={-1}
            onClick={() => { if (!disabled) onSelect(entry); }}
            onKeyDown={(event) => {
              if (disabled) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(entry);
              }
            }}
            onMouseEnter={handleMouseActivity}
            onMouseMove={handleMouseActivity}
            className={cn(
              'w-full text-left px-2 py-1.5 rounded-md typography-meta flex items-center gap-2 cursor-pointer',
              !disabled && (isHighlighted ? 'bg-interactive-selection' : 'hover:bg-interactive-hover/50'),
              disabled && 'cursor-not-allowed opacity-60',
              rowClassName,
            )}
          >
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {dragHandleProps ? (
                <button
                  type="button"
                  ref={dragHandleProps.setActivatorNodeRef}
                  {...dragHandleProps.attributes}
                  {...dragHandleProps.listeners}
                  disabled={disabled}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                  className="model-favorite-drag-handle flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none"
                  aria-label={reorderFavoriteAriaLabel}
                  title={reorderFavoriteTitle}
                >
                  <Icon name="draggable" className="size-3.5" />
                </button>
              ) : null}
              {showProviderLogo ? <ProviderLogo providerId={entry.providerID} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
              <span className="font-medium truncate">{getModelDisplayName(entry.model)}</span>
              {contextTokens ? <span className="typography-micro text-muted-foreground flex-shrink-0">{contextTokens}</span> : null}
            </div>
            {count > 0 ? <span className="typography-micro text-muted-foreground flex-shrink-0">x{count}</span> : null}
            {renderRowEnd?.(entry, { isHighlighted, isSelected })}
            {isSelected ? <Icon name="check" className="h-4 w-4 text-primary flex-shrink-0" /> : null}
            {onToggleFavorite ? (
              <button
                type="button"
                disabled={disabled}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggleFavorite(entry); }}
                className={cn('model-favorite-button flex h-4 w-4 items-center justify-center hover:text-primary/80 flex-shrink-0 disabled:pointer-events-none', favorite ? 'text-primary' : 'text-muted-foreground')}
                aria-label={favorite ? labels.unfavorite : labels.favorite}
                title={favorite ? labels.unfavorite : labels.favorite}
              >
                <Icon name={favorite ? 'star-fill' : 'star'} className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        );

        return (
          <ModelPickerRowTooltip metadata={metadata} active={tooltipsEnabled && isHighlighted} labels={labels}>
            {rowElement}
          </ModelPickerRowTooltip>
        );
      }}
    </ModelPickerRowHighlight>
  );
};
