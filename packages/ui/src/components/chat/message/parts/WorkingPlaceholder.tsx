import React from 'react';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';

interface WorkingPlaceholderProps {
  isWorking: boolean;
  statusText: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
  /** Authoritative turn start (unix ms) — pins the elapsed counter. */
  startedAt?: number | null;
}

const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

const toRetryTargetTimestamp = (next: number): number => {
  if (next >= EPOCH_MILLISECONDS_THRESHOLD) {
    return next;
  }
  if (next >= EPOCH_SECONDS_THRESHOLD) {
    return next * 1000;
  }
  return Date.now() + next;
};

const formatRetryCountdown = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const remainderMinutes = Math.floor((seconds % 3600) / 60);
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(seconds / 86400);
  const remainderHours = Math.floor((seconds % 86400) / 3600);
  if (remainderHours > 0) {
    return `${days}d ${remainderHours}h`;
  }

  return `${days}d`;

};

export function WorkingPlaceholder({
  isWorking,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  retryInfo,
  modelName,
  providerId,
  startedAt = null,
}: WorkingPlaceholderProps) {
  const { src: providerLogoSrc, onError: handleProviderLogoError, hasLogo: hasProviderLogo } = useProviderLogo(providerId ?? null);
  const { currentTheme } = useThemeSystem();
  const isDarkTheme = currentTheme?.metadata.variant === 'dark';
  const displayedStatusRef = React.useRef<{ text: string; permission: boolean } | null>(null);

  // Countdown state for retry mode
  const [retryCountdown, setRetryCountdown] = React.useState<number | null>(null);

  React.useEffect(() => {
    const rawNext = retryInfo?.next;
    if (!rawNext || rawNext <= 0) {
      setRetryCountdown(null);
      return;
    }

    const retryTargetAt = toRetryTargetTimestamp(rawNext);

    const update = () => {
      const remaining = Math.max(0, retryTargetAt - Date.now());
      setRetryCountdown(Math.ceil(remaining / 1000));
    };

    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [retryInfo?.next, retryInfo?.attempt]);

  if (!isWorking) {
    displayedStatusRef.current = null;
    return null;
  }

  // Retry state: show countdown and attempt info
  if (retryInfo) {
    displayedStatusRef.current = null;
    const attemptLabel = retryInfo.attempt && retryInfo.attempt > 1 ? ` (attempt ${retryInfo.attempt})` : '';
    const countdownLabel = retryCountdown !== null && retryCountdown > 0
      ? ` in ${formatRetryCountdown(retryCountdown)}`
      : '';
    const retryText = `Retrying${countdownLabel}${attemptLabel}`;

    return (
      <div
        className="flex h-full min-w-0 items-center text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-label={`${retryText}...`}
      >
        <AgentThinkingLoader text={retryText} variant="inline" showElapsed={false} className="min-w-0" />
      </div>
    );
  }

  const incomingText = isWaitingForPermission ? 'waiting for permission' : statusText;
  const incomingPermission = Boolean(isWaitingForPermission);
  const incomingGeneric = Boolean(isGenericStatus) && !incomingPermission;

  // Render real phase changes in the same pass as their props. The previous
  // effect-backed mirror left one stale or empty frame between tool calls and
  // caused an extra render for every phase change. Generic filler still keeps
  // the latest useful status until another real phase arrives.
  if (incomingText && (!incomingGeneric || displayedStatusRef.current === null)) {
    displayedStatusRef.current = { text: incomingText, permission: incomingPermission };
  }

  const displayedStatus = displayedStatusRef.current;
  if (!displayedStatus) {
    return null;
  }

  const trimmedModelName = typeof modelName === 'string' ? modelName.trim() : '';
  const label = trimmedModelName.length > 0
    ? `${trimmedModelName} is ${displayedStatus.text}`
    : displayedStatus.text.charAt(0).toUpperCase() + displayedStatus.text.slice(1);

  return (
    <div
      className="flex h-full min-w-0 items-center text-muted-foreground"
      role="status"
      aria-live={displayedStatus.permission ? 'assertive' : 'polite'}
      aria-label={label}
      data-waiting={displayedStatus.permission ? 'true' : undefined}
    >
      <span className="typography-ui-header inline-flex min-w-0 items-center gap-1.5 leading-5">
        {hasProviderLogo && providerLogoSrc ? (
          <img
            src={providerLogoSrc}
            alt=""
            aria-hidden="true"
            className="inline-block h-3.5 w-3.5 mr-0.5 align-[-2px]"
            style={{
              filter: isDarkTheme ? 'brightness(0.9) contrast(1.1) invert(1)' : 'brightness(0.9) contrast(1.1)',
            }}
            onError={handleProviderLogoError}
          />
        ) : null}
        <AgentThinkingLoader text={label} variant="inline" animationType="spinner" startedAt={startedAt} className="min-w-0" />
      </span>
    </div>
  );
}
