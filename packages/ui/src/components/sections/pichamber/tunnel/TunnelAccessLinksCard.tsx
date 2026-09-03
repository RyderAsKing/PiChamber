import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SETTINGS_CALLOUT_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { formatAbsoluteTime } from './tunnelHelpers';
import type { RenderedTunnelSessionRecord } from './tunnelTypes';

export interface TunnelAccessLinksCardProps {
  records: RenderedTunnelSessionRecord[];
  timeFormatPreference: TimeFormatPreference;
}

export const TunnelAccessLinksCard: React.FC<TunnelAccessLinksCardProps> = ({
  records,
  timeFormatPreference,
}) => {
  if (records.length === 0) {
    return null;
  }

  return (
    <section className="space-y-2 px-2 pb-2 pt-0">
      <div className="rounded-lg border border-[var(--status-info-border)] bg-[var(--status-info-background)]/30 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="information" className="size-4 text-[var(--status-info)]" />
          <p className={SETTINGS_CALLOUT_TITLE_CLASS}>{'Redeemed access links'}</p>
        </div>
        <div className="space-y-1">
          {records.map((record) => {
            const isQuick = record.mode === 'quick';
            const isManagedRemote = record.mode === 'managed-remote';
            const modeBadgeClass = isQuick
              ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning)]'
              : isManagedRemote
                ? 'border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)]'
                : 'border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)]';
            const statusDotClass = record.isActive
              ? isQuick
                ? 'text-[var(--status-warning)]'
                : isManagedRemote
                  ? 'text-[var(--status-info)]'
                  : 'text-[var(--status-success)]'
              : 'text-muted-foreground/50';
            const modeLabel = isQuick
              ? 'QUICK'
              : isManagedRemote
                ? 'REMOTE'
                : 'LOCAL';

            return (
              <div
                key={record.sessionId}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-[var(--surface-subtle)] bg-[var(--surface-elevated)] px-2 py-1.5"
              >
                <Icon
                  name="checkbox-blank-circle-fill"
                  className={cn('size-2.5 shrink-0', statusDotClass)}
                />
                <span
                  className={cn(
                    'typography-micro rounded border px-1.5 py-0.5 uppercase',
                    modeBadgeClass
                  )}
                >
                  {modeLabel}
                </span>
                <span className="typography-meta text-muted-foreground/80">
                  {`Redeemed ${formatAbsoluteTime(record.createdAt, timeFormatPreference)}`}
                </span>
                <span className="typography-meta text-foreground">
                  {record.isActive
                    ? `Expires in ${record.remainingTextForSession}`
                    : record.inactiveLabel === 'Inactive'
                      ? 'Inactive'
                      : `Inactive (${record.inactiveLabel})`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
