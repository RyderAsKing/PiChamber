import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SETTINGS_CALLOUT_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import type { TunnelDependencyInstallInfo } from './tunnelTypes';

export interface TunnelDependencyMissingCardProps {
  installInfo: TunnelDependencyInstallInfo;
}

export const TunnelDependencyMissingCard: React.FC<TunnelDependencyMissingCardProps> = ({
  installInfo,
}) => {
  return (
    <section className="space-y-2 px-2 pb-2 pt-0">
      <div className="flex items-start gap-2 rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 p-3">
        <Icon
          name="error-warning"
          className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]"
        />
        <div className="space-y-1">
          <p className={SETTINGS_CALLOUT_TITLE_CLASS}>
            {`${installInfo.dependency} was not found.`}
          </p>
          <p className="typography-meta text-muted-foreground/70">
            {'Install it to enable remote tunnel access:'}
          </p>
          <code className="typography-code block rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
            {installInfo.installCommand}
          </code>
        </div>
      </div>
    </section>
  );
};
