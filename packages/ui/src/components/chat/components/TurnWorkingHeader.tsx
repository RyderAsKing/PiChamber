import React from 'react';

import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { useSessionActivityStartedAt } from '@/sync/session-activity-timing';
import { stripAnsi } from '@/lib/pi/ansi';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { WorkingPlaceholder } from '../message/parts/WorkingPlaceholder';
import { formatTurnDuration, resolveTurnDurationMs } from '../message/turnDuration';
import { formatTurnActivityClauses, formatTurnActivityFailures, type TurnActivitySummary } from '../lib/turns/summarizeTurnActivity';

interface TurnWorkingHeaderProps {
    turnId: string;
    isLiveTurn: boolean;
    isWorking: boolean;
    /** Latest turn last seen working while the transport is unverified. */
    isAwaitingRecovery?: boolean;
    hasActivity: boolean;
    isActivityExpanded: boolean;
    onToggleActivity: () => void;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    liveStatusText?: string;
    wasSteered?: boolean;
    /** What the turn's tools did, shown after the duration once it settles. */
    activitySummary?: TurnActivitySummary;
}

const LiveTurnStatus: React.FC<{
    isWorking: boolean;
    startedAt?: number;
    statusText?: string;
}> = React.memo(({ isWorking, startedAt, statusText }) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const extensionWorking = usePiSessionSnapshot(
        React.useCallback((state) => {
            const session = currentSessionId ? state.reducer.bySession.get(currentSessionId) : undefined;
            return session?.extensionWorking;
        }, [currentSessionId]),
        (a, b) => a?.message === b?.message && a?.visible === b?.visible,
        currentSessionId ? `session:${currentSessionId}` : 'chrome',
    );
    const { activeModel, working } = useAssistantStatus();
    const authoritativeStartedAt = useSessionActivityStartedAt(currentSessionId ?? '');
    const providers = useConfigStore((state) => state.providers);

    const modelDisplayName = React.useMemo(() => {
        if (!activeModel) {
            return null;
        }
        const provider = providers.find((candidate) => candidate.id === activeModel.providerId);
        return getProviderModelDisplayName(provider, activeModel.modelId) || null;
    }, [activeModel, providers]);

    if (extensionWorking?.visible === false) {
        return null;
    }

    const effectiveStatusText = extensionWorking?.message
        ? stripAnsi(extensionWorking.message)
        : (statusText ?? working.statusText);
    const isGeneric = extensionWorking?.message
        ? false
        : (statusText ? false : working.isGenericStatus);

    return (
        <WorkingPlaceholder
            isWorking={isWorking || working.isWorking}
            statusText={effectiveStatusText}
            isGenericStatus={isGeneric}
            isWaitingForPermission={working.isWaitingForPermission}
            retryInfo={working.retryInfo}
            modelName={modelDisplayName}
            providerId={activeModel?.providerId ?? null}
            startedAt={statusText
                ? (startedAt ?? authoritativeStartedAt ?? null)
                : (authoritativeStartedAt ?? startedAt ?? null)}
        />
    );
});

LiveTurnStatus.displayName = 'LiveTurnStatus';

const TurnWorkingHeader: React.FC<TurnWorkingHeaderProps> = ({
    turnId,
    isLiveTurn,
    isWorking,
    isAwaitingRecovery = false,
    hasActivity,
    isActivityExpanded,
    onToggleActivity,
    startedAt,
    completedAt,
    durationMs,
    liveStatusText,
    wasSteered,
    activitySummary,
}) => {
    const resolvedDurationMs = resolveTurnDurationMs({ startedAt, completedAt, durationMs });
    // Reconnecting keeps the last-observed state visible without claiming it
    // is current (no live timer) or finished (no manufactured duration). A
    // settled turn without timing still labels its disclosure.
    const isReconnecting = !isLiveTurn && isAwaitingRecovery;
    const statusLabel = isLiveTurn
        ? 'Agent working'
        : isReconnecting
          ? 'Reconnecting · last seen working'
          : resolvedDurationMs !== null
            ? `Worked for ${formatTurnDuration(resolvedDurationMs)}${wasSteered ? ' · Steered' : ''}`
            : hasActivity
              ? 'Agent activity'
              : null;
    const activityId = `turn-${turnId}-activity`;
    const clauses = !isLiveTurn && !isReconnecting && activitySummary
        ? formatTurnActivityClauses(activitySummary)
        : [];
    const failed = !isLiveTurn && !isReconnecting ? (activitySummary?.failed ?? 0) : 0;
    const chevron = (
        <Icon
            name="arrow-right-s"
            className={cn(
                'size-4 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none',
                isActivityExpanded && 'rotate-90',
            )}
            aria-hidden="true"
        />
    );
    const labelMarkers = isReconnecting
        ? { 'data-turn-reconnecting': 'true' }
        : { 'data-agent-worked-row': 'true' };

    return (
        <div
            className="chat-message-column mb-1"
            data-turn-working-header="true"
            data-turn-working={isLiveTurn && isWorking ? 'true' : 'false'}
        >
            <div className="flex min-h-6 items-center gap-1 py-0.5">
                {isLiveTurn ? (
                    <>
                        <div className="flex min-w-0 items-center overflow-hidden">
                            <LiveTurnStatus isWorking={isWorking} startedAt={startedAt} statusText={liveStatusText} />
                        </div>
                        {hasActivity ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={cn(
                                    'h-6 w-6 shrink-0 rounded-md p-0 text-muted-foreground',
                                    'hover:bg-interactive-hover hover:text-foreground',
                                )}
                                aria-expanded={isActivityExpanded}
                                aria-controls={activityId}
                                aria-label={isActivityExpanded ? 'Collapse activity' : 'Expand activity'}
                                data-turn-activity-toggle="true"
                                onClick={onToggleActivity}
                            >
                                {chevron}
                            </Button>
                        ) : null}
                    </>
                ) : hasActivity && statusLabel ? (
                    // The whole settled line opens the activity: the duration,
                    // what the tools did, and the chevron are one target.
                    <button
                        type="button"
                        className={cn(
                            'group/turn-activity -mx-1.5 flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5',
                            'typography-markdown leading-6 text-muted-foreground',
                            'hover:bg-interactive-hover hover:text-foreground',
                        )}
                        aria-expanded={isActivityExpanded}
                        aria-controls={activityId}
                        data-turn-activity-toggle="true"
                        onClick={onToggleActivity}
                    >
                        <span className="min-w-0 truncate">
                            <span {...labelMarkers}>{statusLabel}</span>
                            {clauses.length > 0 ? (
                                <span className="text-subtle-foreground group-hover/turn-activity:text-muted-foreground" data-turn-activity-summary="true">
                                    {clauses.map((clause) => ` · ${clause}`).join('')}
                                </span>
                            ) : null}
                            {failed > 0 ? (
                                <span className="text-[var(--status-error)]" data-turn-activity-failed="true">
                                    {` · ${formatTurnActivityFailures(failed)}`}
                                </span>
                            ) : null}
                        </span>
                        {chevron}
                    </button>
                ) : statusLabel ? (
                    <span
                        className="typography-markdown inline-flex min-w-0 items-center leading-5 text-muted-foreground"
                        role="status"
                        aria-label={statusLabel}
                        {...labelMarkers}
                    >
                        {statusLabel}
                    </span>
                ) : null}
            </div>
        </div>
    );
};

export default React.memo(TurnWorkingHeader);
