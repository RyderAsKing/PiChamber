import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  BOOTSTRAP_TTL_OPTIONS,
  SESSION_TTL_OPTIONS,
  ttlOptionLabel,
  ttlOptionValue,
} from './tunnelHelpers';
import type { TunnelMode } from './tunnelTypes';

export interface TunnelTtlControlsProps {
  bootstrapTtlMs: number | null;
  sessionTtlMs: number;
  tunnelMode: TunnelMode;
  disabled: boolean;
  providerSupportsManagedModes: boolean;
  onBootstrapTtlChange: (val: string) => void;
  onSessionTtlChange: (val: string) => void;
}

export const TunnelTtlControls: React.FC<TunnelTtlControlsProps> = ({
  bootstrapTtlMs,
  sessionTtlMs,
  tunnelMode,
  disabled,
  providerSupportsManagedModes,
  onBootstrapTtlChange,
  onSessionTtlChange,
}) => {
  return (
    <>
      <div
        data-settings-item="tunnel.ttl"
        className="mt-2 grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn(SETTINGS_FIELD_LABEL_CLASS, 'shrink-0')}>
            {'Connect link TTL'}
          </span>
          <Select
            value={ttlOptionValue(BOOTSTRAP_TTL_OPTIONS, bootstrapTtlMs, '1800000')}
            onValueChange={onBootstrapTtlChange}
            disabled={disabled}
          >
            <SelectTrigger size={SETTINGS_SELECT_SIZE} className="max-w-[11rem] min-w-0">
              <SelectValue className="truncate">
                {ttlOptionLabel(BOOTSTRAP_TTL_OPTIONS, bootstrapTtlMs, '1800000')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BOOTSTRAP_TTL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <span className={cn(SETTINGS_FIELD_LABEL_CLASS, 'shrink-0')}>
            {'Tunnel session TTL'}
          </span>
          <Select
            value={ttlOptionValue(SESSION_TTL_OPTIONS, sessionTtlMs, '28800000')}
            onValueChange={onSessionTtlChange}
            disabled={disabled}
          >
            <SelectTrigger size={SETTINGS_SELECT_SIZE} className="max-w-[11rem] min-w-0">
              <SelectValue className="truncate">
                {ttlOptionLabel(SESSION_TTL_OPTIONS, sessionTtlMs, '28800000')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SESSION_TTL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {tunnelMode === 'quick' && (
        <div className="rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 p-3">
          <div className="flex items-start gap-2">
            <Icon
              name="error-warning"
              className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]"
            />
            <div>
              <p className="typography-meta text-[var(--status-warning)]">
                {'Quick Tunnel is best effort and uptime is not guaranteed.'}
              </p>
              {providerSupportsManagedModes && (
                <p className="typography-meta mt-1 text-[var(--status-warning)]">
                  {
                    'For more reliable long-lived access, switch to Managed Remote or Managed Local tunnel mode.'
                  }
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
