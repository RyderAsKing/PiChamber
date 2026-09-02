import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { getProviderLabel } from './tunnelHelpers';

export const ProviderOptionLabel: React.FC<{ provider: string }> = ({ provider }) => {
  const label = getProviderLabel(provider);
  const isCloudflare = provider === 'cloudflare';

  return (
    <span className="flex items-center gap-2">
      <Icon
        name="cloud"
        className={cn(
          'size-4 shrink-0',
          isCloudflare ? 'text-[var(--status-warning)]' : 'text-muted-foreground'
        )}
      />
      <span>{label}</span>
    </span>
  );
};
