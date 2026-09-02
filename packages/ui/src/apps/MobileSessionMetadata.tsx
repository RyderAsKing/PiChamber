import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ContextProgressIcon } from '@/components/ui/ContextProgressIcon';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { computeCacheHitRate, computePiContextWindowTokens, extractSessionMessageBreakdown, type PiUsageLike } from '@/stores/utils/tokenUtils';
import { MOBILE_HEADER_POPOVER_WIDTH, useMobileHeaderOverlay } from './useMobileHeaderOverlay';

const getNumericLimit = (limit: unknown, key: 'context' | 'output'): number | undefined => {
  if (!limit || typeof limit !== 'object') return undefined;
  const value = (limit as Partial<Record<'context' | 'output', unknown>>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

type ContextDisplay = {
  percentage: number;
  tokens: string;
  colorClass: string;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheHitPercent: number | null;
} | null;

const MetadataRow: React.FC<{
  icon?: IconName;
  iconNode?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, iconNode, label, children }) => (
  <div className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5">
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {iconNode ?? (icon ? <Icon name={icon} className="size-[18px]" /> : null)}
    </span>
    <span className="shrink-0 typography-ui-label text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-1 truncate text-right typography-ui-label font-medium text-foreground">
      {children}
    </span>
  </div>
);

const SessionMetadataOverlay: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  contextDisplay: ContextDisplay;
  cacheSubtitle?: string | null;
}> = ({ open, onClose, anchorRef, contextDisplay }) => {
  const { panelRef, wrapperRef, shouldRender, isExiting, anchorLeft, isPopover } = useMobileHeaderOverlay({
    open,
    onClose,
    anchorRef,
    closeOnWheel: true,
  });

  if (!shouldRender) return null;

  return (
    <div ref={wrapperRef} className="fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-20 pointer-events-none">
      <div
        ref={panelRef}
        role="tooltip"
        aria-label={"Context usage for current conversation"}
        className={cn(
          'overflow-y-auto overscroll-contain rounded-lg border border-border/70 bg-[var(--surface-elevated)] p-2 shadow-[0_8px_24px_rgb(0_0_0_/_0.18)] will-change-transform',
          isPopover ? 'absolute origin-top-left' : 'mx-3 mt-2',
          isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        style={{
          animation: `${isExiting ? 'session-metadata-out' : 'session-metadata-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-header-height, 56px) - 1rem))',
          ...(isPopover
            ? {
                top: 8,
                left: anchorLeft ?? 8,
                width: `min(${MOBILE_HEADER_POPOVER_WIDTH}px, calc(100% - 16px))`,
              }
            : null),
        }}
      >
        <div className="space-y-1">
          {contextDisplay ? (
            <>
              <MetadataRow
                iconNode={<ContextProgressIcon percentage={contextDisplay.percentage} />}
                label={"Context"}
              >
                <span className="inline-flex items-baseline gap-1.5 tabular-nums">
                  <span className={cn('font-semibold', contextDisplay.colorClass)}>{contextDisplay.percentage.toFixed(1)}%</span>
                  <span className="text-muted-foreground">{contextDisplay.tokens}</span>
                </span>
              </MetadataRow>
              {contextDisplay.cacheRead !== null && contextDisplay.cacheWrite !== null ? (
                <>
                  <MetadataRow icon="stack" label={"Cache read"}>
                    <span className="tabular-nums">{formatTokens(contextDisplay.cacheRead)}</span>
                  </MetadataRow>
                  <MetadataRow icon="edit" label={"Cache write"}>
                    <span className="tabular-nums">{formatTokens(contextDisplay.cacheWrite)}</span>
                  </MetadataRow>
                </>
              ) : null}
              {contextDisplay.cacheHitPercent !== null ? (
                <MetadataRow icon="check" label={"Cache hit"}>
                  <span className="tabular-nums">{contextDisplay.cacheHitPercent.toFixed(1)}%</span>
                </MetadataRow>
              ) : null}
            </>
          ) : (
            <div className="px-2.5 py-2 typography-meta text-muted-foreground">
              {"Context usage is not available for this conversation yet."}
            </div>
          )}
        </div>
      </div>
      <style>{`
        @keyframes session-metadata-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-metadata-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};

export const MobileSessionMetadataButton = React.memo(function MobileSessionMetadataButton({
  open,
  onOpenChange,
  currentSessionId,
  effectiveDirectory,
  isNewSessionDraftOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean | ((open: boolean) => boolean)) => void;
  currentSessionId: string | null;
  effectiveDirectory: string | null;
  isNewSessionDraftOpen: boolean;
}) {
  const metadataTriggerRef = React.useRef<HTMLButtonElement>(null);
  const activeSessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveDirectory ?? undefined);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const currentModel = useConfigStore((state) => state.getCurrentModel());
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  useConfigStore((state) => state.modelsMetadata.size);
  const savedSessionModel = useSelectionStore(
    React.useCallback(
      (state) => (currentSessionId ? state.sessionModelSelections.get(currentSessionId) ?? null : null),
      [currentSessionId],
    ),
  );

  const latestMessageModel = React.useMemo(() => {
    for (let i = activeSessionMessageRecords.length - 1; i >= 0; i -= 1) {
      const message = activeSessionMessageRecords[i]?.info as typeof activeSessionMessageRecords[number]['info'] & {
        model?: { providerID?: string; modelID?: string; providerId?: string; modelId?: string };
      };
      if (message.role !== 'user') continue;
      const messageModel = message.model;
      const providerCandidate = messageModel?.providerID ?? messageModel?.providerId;
      const modelCandidate = messageModel?.modelID ?? messageModel?.modelId;
      const providerID = typeof providerCandidate === 'string' && providerCandidate.trim().length > 0
        ? providerCandidate
        : undefined;
      const modelID = typeof modelCandidate === 'string' && modelCandidate.trim().length > 0
        ? modelCandidate
        : undefined;
      if (providerID && modelID) return { providerID, modelID };
    }
    return null;
  }, [activeSessionMessageRecords]);

  const contextMessage = React.useMemo(() => {
    for (let i = activeSessionMessageRecords.length - 1; i >= 0; i -= 1) {
      const record = activeSessionMessageRecords[i];
      if (record?.info.role !== 'assistant') continue;
      if (extractSessionMessageBreakdown(record).total > 0) return record;
    }
    return null;
  }, [activeSessionMessageRecords]);

  const modelRef = latestMessageModel
    ?? (() => {
      const model = contextMessage?.info.model as { providerID?: string; providerId?: string; modelID?: string; modelId?: string } | undefined;
      const providerID = model?.providerID ?? model?.providerId;
      const modelID = model?.modelID ?? model?.modelId;
      return providerID && modelID ? { providerID, modelID } : null;
    })()
    ?? (savedSessionModel ? { providerID: savedSessionModel.providerId, modelID: savedSessionModel.modelId } : null)
    ?? (currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null);
  const provider = modelRef ? providers.find((entry) => entry.id === modelRef.providerID) : undefined;
  const liveModel = provider?.models.find((model) => model.id === modelRef?.modelID);
  const metadata = modelRef ? getModelMetadata(modelRef.providerID, modelRef.modelID) : undefined;
  const contextLimit = getNumericLimit((liveModel as { limit?: unknown } | undefined)?.limit, 'context')
    ?? metadata?.limit?.context
    ?? getNumericLimit((currentModel as { limit?: unknown } | undefined)?.limit, 'context')
    ?? 0;
  const contextBreakdown = contextMessage ? extractSessionMessageBreakdown(contextMessage) : null;
  const contextUsage = (contextMessage?.info as { usage?: PiUsageLike } | undefined)?.usage;
  const totalTokens = contextUsage
    ? computePiContextWindowTokens(contextUsage)
    : contextBreakdown?.total ?? 0;

  const contextPercentage =
    !isNewSessionDraftOpen && totalTokens > 0 && contextLimit > 0
      ? Math.min((totalTokens / contextLimit) * 100, 999)
      : null;
  const contextTokens = contextPercentage !== null
    ? `${formatTokens(totalTokens)}/${formatTokens(contextLimit)}`
    : null;
  const contextColorClass =
    contextPercentage === null
      ? ''
      : contextPercentage >= 90
        ? 'text-[var(--status-error)]'
        : contextPercentage >= 75
          ? 'text-[var(--status-warning)]'
          : 'text-[var(--status-success)]';
  const cacheRead = contextBreakdown?.cacheRead ?? null;
  const cacheWrite = contextBreakdown?.cacheWrite ?? null;
  const cacheHit = contextBreakdown
    ? computeCacheHitRate({ input: contextBreakdown.input, cache: { read: contextBreakdown.cacheRead, write: contextBreakdown.cacheWrite } })
    : { percent: 0, hasInput: false };
  const cacheHitPercent = cacheHit.hasInput ? cacheHit.percent : null;
  const contextDisplay: ContextDisplay = contextPercentage !== null && contextTokens
    ? { percentage: contextPercentage, tokens: contextTokens, colorClass: contextColorClass, cacheRead, cacheWrite, cacheHitPercent }
    : null;

  return (
    <>
      <button
        ref={metadataTriggerRef}
        type="button"
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={"Show context usage for current conversation"}
        title={"Context usage"}
        aria-expanded={open}
        onClick={() => onOpenChange((currentOpen) => !currentOpen)}
        style={{ touchAction: 'manipulation' }}
      >
        <ContextProgressIcon percentage={contextDisplay?.percentage ?? 0} />
      </button>
      <SessionMetadataOverlay
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={metadataTriggerRef}
        contextDisplay={contextDisplay}
      />
    </>
  );
});
