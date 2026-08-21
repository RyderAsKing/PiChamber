import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Icon } from '@/components/icon/Icon';
import { ContextProgressIcon } from '@/components/ui/ContextProgressIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { computeCacheHitRate, computePiContextWindowTokens, extractSessionMessageBreakdown, type PiUsageLike } from '@/stores/utils/tokenUtils';
import {
  getGitRailPresentation,
  getVisibleContextRailSurfaces,
  sortContextSurfaces,
  type ContextSurfaceDescriptor,
} from '@/lib/surfaces/registry';
import {
  getEffectiveShortcutPrefix,
  isShortcutPrefixHeld,
} from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useGitStatus, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

const RAIL_TOOLTIP_DELAY_MS = 150;
// Hold the surface-switch modifier for this long before revealing the order
// number badges on the rail icons.
const RAIL_NUMBER_HOLD_DELAY_MS = 500;
const EMPTY_TABS: never[] = [];

type RailItemProps = {
  surface: ContextSurfaceDescriptor;
  isActive: boolean;
  showActivityDot: boolean;
  label: string;
  description: string;
  /** Numeric badge (e.g. the Git changed-files count); takes precedence over the activity dot. */
  badgeCount?: number | null;
  /** Accessible label that includes the badge count; falls back to `label`. */
  badgeAriaLabel?: string | null;
  /** Extra tooltip line describing the badge; rendered under the description. */
  badgeDescription?: string | null;
  orderNumber?: number | null;
  showOrderNumber?: boolean;
  onSelect: (surface: ContextSurfaceDescriptor) => void;
  /** When set and surface is "context", renders the live circular chart instead of the static icon. */
  chartPercentage?: number | null;
  /** Rich tooltip data that mirrors the mobile popover (progress + token breakdown + cache). */
  chartDetails?: {
    percentage: number;
    totalTokens: number;
    contextLimit: number;
    outputLimit: number;
    cacheRead: number | null;
    cacheWrite: number | null;
    cacheHitPercent: number | null;
    hasData: boolean;
  } | null;
};

const formatTokensCompact = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

const getRailNumericLimit = (limit: unknown, key: 'context' | 'output'): number | undefined => {
  if (!limit || typeof limit !== 'object') return undefined;
  const v = (limit as Partial<Record<'context' | 'output', unknown>>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

// The badge corner is 16px tall; cap large counts so the pill stays compact
// on the 36px rail button (matching the order-number badge's footprint).
const formatRailBadgeCount = (count: number): string => (count > 99 ? '99+' : String(count));

const getRailPercentageColor = (pct: number): string => {
  if (pct >= 90) return 'text-[var(--status-error)]';
  if (pct >= 75) return 'text-[var(--status-warning)]';
  return 'text-[var(--status-success)]';
};

const ContextPanelRailItem: React.FC<RailItemProps> = ({
  surface,
  isActive,
  showActivityDot,
  label,
  description,
  badgeCount,
  badgeAriaLabel,
  badgeDescription,
  orderNumber,
  showOrderNumber,
  onSelect,
  chartPercentage,
  chartDetails,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
  });

  const displayBadgeCount = badgeCount != null && badgeCount > 0 ? formatRailBadgeCount(badgeCount) : null;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-70')}
    >
      <Tooltip delayDuration={RAIL_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={() => onSelect(surface)}
            aria-label={badgeAriaLabel ?? label}
            aria-pressed={isActive}
            className={cn(
              'flex h-9 w-9 touch-none select-none items-center justify-center rounded-md transition-colors',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {surface.id === 'context' && typeof chartPercentage === 'number' ? (
              <ContextProgressIcon percentage={chartPercentage} className="size-[18px] -rotate-90" />
            ) : (
              <Icon name={surface.icon} className="h-[18px] w-[18px]" />
            )}
            {showOrderNumber && orderNumber != null ? (
              <span
                aria-hidden="true"
                className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-muted px-1 text-[0.625rem] font-medium leading-none text-muted-foreground"
              >
                {orderNumber === 10 ? '0' : orderNumber}
              </span>
            ) : displayBadgeCount ? (
              <span
                aria-hidden="true"
                // Muted digits on the muted surface sat at almost the same
                // luminance as the glyph they overlap. The count is a live
                // signal, so it takes the info tone on its own opaque chip.
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold leading-none"
                style={{
                  backgroundColor: 'var(--status-info-background)',
                  color: 'var(--status-info)',
                }}
              >
                {displayBadgeCount}
              </span>
            ) : showActivityDot ? (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8} className={surface.id === 'context' && chartDetails ? 'p-0 border-0 bg-transparent shadow-none' : undefined}>
          {surface.id === 'context' && chartDetails ? (
            <div className="w-[300px] overflow-hidden rounded-lg border border-border/70 bg-[var(--surface-elevated)] p-2 shadow-[0_8px_24px_rgb(0_0_0_/_0.18)]">
              <div className="space-y-1">
                <div className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5">
                  <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                    <ContextProgressIcon percentage={chartDetails.percentage} className="size-[18px] -rotate-90" />
                  </span>
                  <span className="shrink-0 typography-ui-label text-muted-foreground">{label}</span>
                  <span className="min-w-0 flex-1 truncate text-right typography-ui-label font-medium text-foreground">
                    {chartDetails.hasData ? (
                      <span className="inline-flex items-baseline gap-1.5 tabular-nums">
                        <span className={cn('font-semibold', getRailPercentageColor(chartDetails.percentage))}>{chartDetails.percentage.toFixed(1)}%</span>
                        <span className="text-muted-foreground">{`${formatTokensCompact(chartDetails.totalTokens)}/${formatTokensCompact(chartDetails.contextLimit)}`}</span>
                      </span>
                    ) : (
                      <span className="typography-micro text-muted-foreground">{"No data yet"}</span>
                    )}
                  </span>
                </div>
                {chartDetails.hasData ? (
                  <>
                    <div className="flex justify-between rounded-xl px-2.5 py-1.5 typography-micro">
                      <span className="text-muted-foreground">{"Used tokens"}</span>
                      <span className="font-medium text-foreground tabular-nums">{formatTokensCompact(chartDetails.totalTokens)}</span>
                    </div>
                    <div className="flex justify-between rounded-xl px-2.5 py-1.5 typography-micro">
                      <span className="text-muted-foreground">{"Context limit"}</span>
                      <span className="font-medium text-foreground tabular-nums">{formatTokensCompact(chartDetails.contextLimit)}</span>
                    </div>
                    <div className="flex justify-between rounded-xl px-2.5 py-1.5 typography-micro">
                      <span className="text-muted-foreground">{"Output limit"}</span>
                      <span className="font-medium text-foreground tabular-nums">{formatTokensCompact(chartDetails.outputLimit)}</span>
                    </div>
                    {typeof chartDetails.cacheRead === 'number' && typeof chartDetails.cacheWrite === 'number' ? (
                      <>
                        <div className="flex justify-between rounded-xl px-2.5 py-1.5 typography-micro">
                          <span className="text-muted-foreground">{"Cache read"}</span>
                          <span className="font-medium text-foreground tabular-nums">{formatTokensCompact(chartDetails.cacheRead)}</span>
                        </div>
                        <div className="flex justify-between rounded-xl px-2.5 py-1.5 typography-micro">
                          <span className="text-muted-foreground">{"Cache write"}</span>
                          <span className="font-medium text-foreground tabular-nums">{formatTokensCompact(chartDetails.cacheWrite)}</span>
                        </div>
                      </>
                    ) : null}
                    {typeof chartDetails.cacheHitPercent === 'number' ? (
                      <div className="flex justify-between rounded-xl px-2.5 py-1.5 typography-micro">
                        <span className="text-muted-foreground">{"Cache hit"}</span>
                        <span className="font-medium text-foreground tabular-nums">{`${chartDetails.cacheHitPercent.toFixed(1)}%`}</span>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="px-2.5 py-2 typography-micro text-muted-foreground">
                    {description}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              <span>{label}</span>
              <span className="typography-micro text-muted-foreground">{description}</span>
              {badgeDescription ? (
                <span className="typography-micro text-muted-foreground">{badgeDescription}</span>
              ) : null}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

export const ContextPanelRail: React.FC = () => {
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const contextRailOrder = useUIStore((state) => state.contextRailOrder);
  const setContextRailOrder = useUIStore((state) => state.setContextRailOrder);
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const { screenWidth } = useDeviceInfo();
  const { git } = useRuntimeAPIs();
  const gitStatus = useGitStatus(directoryKey || null);
  const isGitRepo = useIsGitRepo(directoryKey || null);
  const ensureStatus = useGitStore((state) => state.ensureStatus);

  React.useEffect(() => {
    if (!directoryKey) return;
    void ensureStatus(directoryKey, git);
  }, [directoryKey, ensureStatus, git]);

  const surfaceSwitchPrefix = React.useMemo(
    () => getEffectiveShortcutPrefix('switch_context_surface', shortcutOverrides),
    [shortcutOverrides],
  );
  const [revealNumbers, setRevealNumbers] = React.useState(false);

  // While the surface-switch modifier is held for RAIL_NUMBER_HOLD_DELAY_MS,
  // reveal the order number badges so users can see which digit maps to which
  // rail icon. Releasing (or losing focus) dismisses them, and pressing a
  // number key while the chord is armed consumes them for this hold — they
  // only come back on the next press-and-hold.
  React.useEffect(() => {
    const held = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consumedWhileHeld = false;

    const isDigitKey = (key: string) => key.length === 1 && key >= '0' && key <= '9';

    const update = () => {
      const armed = isShortcutPrefixHeld(surfaceSwitchPrefix, held);
      if (armed) {
        if (!consumedWhileHeld && timer === null) {
          timer = setTimeout(() => setRevealNumbers(true), RAIL_NUMBER_HOLD_DELAY_MS);
        }
      } else {
        consumedWhileHeld = false;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        setRevealNumbers(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      held.add(e.key.toLowerCase());
      if (isDigitKey(e.key) && isShortcutPrefixHeld(surfaceSwitchPrefix, held)) {
        consumedWhileHeld = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        setRevealNumbers(false);
        return;
      }
      update();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.key.toLowerCase());
      update();
    };
    const onWindowBlur = () => {
      held.clear();
      consumedWhileHeld = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      setRevealNumbers(false);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onWindowBlur);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onWindowBlur);
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [surfaceSwitchPrefix]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const tabs = panelState?.tabs ?? EMPTY_TABS;
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? null;
  const activeMode = panelState?.isOpen ? activeTab?.mode ?? null : null;
  const changedFilesCount = gitStatus?.files.length ?? 0;

  // ── Live context chart for the "Context" rail entry ──────────────────────
  // Mirrors the header / tablet logic so the rail badge is the same live
  // signal wherever the user sees it: a circular progress that opens the
  // context panel on click and surfaces the token breakdown (including cache)
  // on hover.
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const isNewSessionDraftOpen = useSessionUIStore((s) => Boolean(s.newSessionDraft?.open));
  const providers = useConfigStore((s) => s.providers);
  const currentProviderId = useConfigStore((s) => s.currentProviderId);
  const currentModelId = useConfigStore((s) => s.currentModelId);
  const currentModel = useConfigStore((s) => s.getCurrentModel());
  const getModelMetadata = useConfigStore((s) => s.getModelMetadata);
  useConfigStore((s) => s.modelsMetadata.size);
  const savedSessionModel = useSelectionStore(
    React.useCallback(
      (s) => (currentSessionId ? s.sessionModelSelections.get(currentSessionId) ?? null : null),
      [currentSessionId],
    ),
  );
  const railMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveDirectory ?? undefined);
  const railContextMessage = React.useMemo(() => {
    for (let i = railMessageRecords.length - 1; i >= 0; i -= 1) {
      const rec = railMessageRecords[i];
      if (rec?.info.role !== 'assistant') continue;
      try {
        if (extractSessionMessageBreakdown(rec as unknown as { info: { usage?: PiUsageLike; tokens?: unknown } & Record<string, unknown>; parts: Array<{ tokens?: unknown } & Record<string, unknown>> }).total > 0) return rec;
      } catch {
        continue;
      }
    }
    return null;
  }, [railMessageRecords]);
  const railLatestUserModel = React.useMemo(() => {
    for (let i = railMessageRecords.length - 1; i >= 0; i -= 1) {
      const m = railMessageRecords[i]?.info as typeof railMessageRecords[number]['info'] & { model?: { providerID?: string; modelID?: string; providerId?: string; modelId?: string } };
      if (m.role !== 'user') continue;
      const mm = m.model;
      const p = mm?.providerID ?? mm?.providerId;
      const mid = mm?.modelID ?? mm?.modelId;
      if (typeof p === 'string' && p.trim() && typeof mid === 'string' && mid.trim()) return { providerID: p, modelID: mid };
    }
    return null;
  }, [railMessageRecords]);
  const railModelRef = railLatestUserModel
    ?? (() => {
      const m = railContextMessage?.info.model as { providerID?: string; providerId?: string; modelID?: string; modelId?: string } | undefined;
      const p = m?.providerID ?? m?.providerId;
      const mid = m?.modelID ?? m?.modelId;
      return p && mid ? { providerID: p, modelID: mid } : null;
    })()
    ?? (savedSessionModel ? { providerID: savedSessionModel.providerId, modelID: savedSessionModel.modelId } : null)
    ?? (currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null);
  const railProvider = railModelRef ? providers.find((e) => e.id === railModelRef.providerID) : undefined;
  const railLiveModel = railProvider?.models.find((m) => m.id === railModelRef?.modelID);
  const railMetadata = railModelRef ? getModelMetadata(railModelRef.providerID, railModelRef.modelID) : undefined;
  const railContextLimit = getRailNumericLimit((railLiveModel as { limit?: unknown } | undefined)?.limit, 'context')
    ?? railMetadata?.limit?.context
    ?? getRailNumericLimit((currentModel as { limit?: unknown } | undefined)?.limit, 'context')
    ?? 0;
  const railOutputLimit = getRailNumericLimit((railLiveModel as { limit?: unknown } | undefined)?.limit, 'output')
    ?? railMetadata?.limit?.output
    ?? getRailNumericLimit((currentModel as { limit?: unknown } | undefined)?.limit, 'output')
    ?? 0;
  const railBreakdown = railContextMessage ? (() => { try { return extractSessionMessageBreakdown(railContextMessage as unknown as { info: { usage?: PiUsageLike; tokens?: unknown } & Record<string, unknown>; parts: Array<{ tokens?: unknown } & Record<string, unknown>> }); } catch { return null; } })() : null;
  const railUsage = (railContextMessage?.info as { usage?: PiUsageLike } | undefined)?.usage;
  const railTotalTokens = railUsage ? computePiContextWindowTokens(railUsage) : railBreakdown?.total ?? 0;
  const railPercentage = !isNewSessionDraftOpen && railTotalTokens > 0 && railContextLimit > 0
    ? Math.min((railTotalTokens / railContextLimit) * 100, 999)
    : 0;
  const railChartPercentage = railPercentage;
  const railCacheHit = railBreakdown ? computeCacheHitRate({ input: railBreakdown.input, cache: { read: railBreakdown.cacheRead, write: railBreakdown.cacheWrite } }) : null;
  const railCacheHitPercent = railCacheHit?.hasInput ? railCacheHit.percent : null;
  const railChartDetails = React.useMemo(() => {
    const hasData = !!railContextMessage && railTotalTokens > 0 && railContextLimit > 0;
    return {
      percentage: railPercentage,
      totalTokens: railTotalTokens,
      contextLimit: railContextLimit,
      outputLimit: railOutputLimit,
      cacheRead: railBreakdown?.cacheRead ?? null,
      cacheWrite: railBreakdown?.cacheWrite ?? null,
      cacheHitPercent: railCacheHitPercent,
      hasData,
    };
  }, [railBreakdown, railCacheHitPercent, railContextLimit, railContextMessage, railOutputLimit, railPercentage, railTotalTokens]);

  const surfaces = React.useMemo(() => {
    return getVisibleContextRailSurfaces({
      railOrder: contextRailOrder,
      screenWidth,
      tabs,
    });
  }, [contextRailOrder, screenWidth, tabs]);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const orderedIds = sortContextSurfaces(useUIStore.getState().contextRailOrder).map((surface) => surface.id);
    const fromIndex = orderedIds.indexOf(active.id as (typeof orderedIds)[number]);
    const toIndex = orderedIds.indexOf(over.id as (typeof orderedIds)[number]);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    setContextRailOrder(arrayMove(orderedIds, fromIndex, toIndex));
  }, [setContextRailOrder]);

  if (!directoryKey) {
    return null;
  }

  return (
    <nav
      aria-label={"Panel surfaces"}
      className="flex h-full w-11 flex-shrink-0 flex-col items-center gap-1 bg-background py-2"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={surfaces.map((surface) => surface.id)} strategy={verticalListSortingStrategy}>
          {surfaces.map((surface, index) => {
            const gitPresentation = surface.id === 'git' ? getGitRailPresentation(isGitRepo) : null;
            const railSurface = gitPresentation ? { ...surface, ...gitPresentation } : surface;
            const label = railSurface.label;
            const gitChangedCount = surface.id === 'git' && isGitRepo === true ? changedFilesCount : 0;
            const badgeCount = gitChangedCount > 0 ? gitChangedCount : null;
            const isContextSurface = surface.id === 'context';
            return (
              <ContextPanelRailItem
                key={surface.id}
                surface={railSurface}
                isActive={activeMode === surface.mode}
                showActivityDot={false}
                label={label}
                description={railSurface.description}
                badgeCount={badgeCount}
                badgeAriaLabel={badgeCount !== null
                  ? (badgeCount === 1 ? `${label}, ${badgeCount} changed file` : `${label}, ${badgeCount} changed files`)
                  : null}
                badgeDescription={badgeCount !== null
                  ? (badgeCount === 1 ? `${badgeCount} changed file` : `${badgeCount} changed files`)
                  : null}
                chartPercentage={isContextSurface ? railChartPercentage : undefined}
                chartDetails={isContextSurface ? railChartDetails : undefined}
                orderNumber={index + 1}
                showOrderNumber={revealNumbers}
                onSelect={(selected) => openContextSurface(directoryKey, selected.mode)}
              />
            );
          })}
        </SortableContext>
      </DndContext>
    </nav>
  );
};
