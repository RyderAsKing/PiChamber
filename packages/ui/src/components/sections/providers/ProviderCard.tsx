import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';
import type { PiProvider } from '@/lib/pi/types';

interface ProviderCardProps {
  provider: PiProvider;
  onSelect: (providerId: string) => void;
}

/** Grid card for provider browse. Shows logo, label, model count, and auth status. */
export const ProviderCard: React.FC<ProviderCardProps> = ({ provider, onSelect }) => {
  const modelCount = provider.models.length;
  const modelLabel = modelCount === 1 ? '1 model' : `${modelCount} models`;
  const { hasLogo } = useProviderLogo(provider.id);

  return (
    <button
      type="button"
      onClick={() => onSelect(provider.id)}
      aria-label={`${provider.label} provider, ${modelLabel}${provider.authenticated ? ', authenticated' : ''}`}
      className={cn(
        'group flex min-h-[118px] flex-col gap-3 rounded-xl border bg-[var(--surface-elevated)] p-4 text-left',
        'border-border/60 hover:bg-interactive-hover hover:border-border',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        'transition-colors duration-150',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {hasLogo ? (
          <ProviderLogo providerId={provider.id} className="size-8 shrink-0 rounded-md object-contain" />
        ) : (
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon name="cloud" className="size-4" aria-hidden />
          </span>
        )}
        {provider.authenticated ? (
          <span className="inline-flex items-center gap-1 typography-micro font-medium text-[var(--status-success)]">
            <Icon name="check" className="size-3.5" aria-hidden />
            Connected
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate typography-ui-label font-medium text-foreground">{provider.label}</div>
        <div className="truncate font-mono typography-micro text-muted-foreground">{provider.id}</div>
      </div>

      <div className="flex items-center gap-1.5 typography-micro text-muted-foreground">
        <Icon name="stack" className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="tabular-nums">{modelLabel}</span>
      </div>
    </button>
  );
};

interface ProviderCardSkeletonProps {
  count?: number;
}

export const ProviderCardSkeleton: React.FC<ProviderCardSkeletonProps> = ({ count = 6 }) => (
  <>
    {Array.from({ length: count }).map((_, index) => (
      <div
        key={index}
        className="flex min-h-[118px] flex-col gap-3 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="size-8 shrink-0 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-16 animate-pulse rounded bg-muted" />
        </div>
        <div className="space-y-1.5">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-3 w-16 animate-pulse rounded bg-muted" />
      </div>
    ))}
  </>
);
