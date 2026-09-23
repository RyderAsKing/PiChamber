import React from 'react';

import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionActivityStartedAt } from '@/sync/session-activity-timing';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { WorkingPlaceholder } from '../message/parts/WorkingPlaceholder';
import { formatTurnDuration, resolveTurnDurationMs } from '../message/turnDuration';

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
}

const LiveTurnStatus: React.FC<{
    isWorking: boolean;
    startedAt?: number;
    statusText?: string;
}> = React.memo(({ isWorking, startedAt, statusText }) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
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

    return (
        <WorkingPlaceholder
            isWorking={isWorking || working.isWorking}
            statusText={statusText ?? working.statusText}
            isGenericStatus={statusText ? false : working.isGenericStatus}
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

    return (
        <div
            className="chat-message-column mb-1"
            data-turn-working-header="true"
            data-turn-working={isLiveTurn && isWorking ? 'true' : 'false'}
        >
            <div className="flex min-h-6 items-center gap-1 py-0.5">
                <div className="flex min-w-0 items-center overflow-hidden">
                    {isLiveTurn ? (
                        <LiveTurnStatus isWorking={isWorking} startedAt={startedAt} statusText={liveStatusText} />
                    ) : statusLabel ? (
                        <span
                            className="typography-markdown inline-flex min-w-0 items-center leading-5 text-muted-foreground"
                            role="status"
                            aria-label={statusLabel}
                            {...(isReconnecting
                                ? { 'data-turn-reconnecting': 'true' }
                                : { 'data-agent-worked-row': 'true' })}
                        >
                            {statusLabel}
                        </span>
                    ) : null}
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
                        <Icon
                            name="arrow-right-s"
                            className={cn(
                                'size-4 transition-transform duration-200 ease-out motion-reduce:transition-none',
                                isActivityExpanded && 'rotate-90',
                            )}
                            aria-hidden="true"
                        />
                    </Button>
                ) : null}
            </div>
        </div>
    );
};

export default React.memo(TurnWorkingHeader);
