import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  MANAGED_LOCAL_TUNNEL_DOC_URL,
  MANAGED_REMOTE_TUNNEL_DOC_URL,
  TUNNEL_MODE_OPTIONS,
} from './tunnelHelpers';
import type {
  ManagedRemoteTunnelPreset,
  TunnelMode,
  TunnelState,
} from './tunnelTypes';

export interface TunnelStartControlsProps {
  tunnelMode: TunnelMode;
  selectedPresetId: string;
  managedRemoteTunnelPresets: ManagedRemoteTunnelPreset[];
  selectedPreset: ManagedRemoteTunnelPreset | null;
  willReplaceActiveTunnel: boolean;
  state: TunnelState;
  isSavingMode: boolean;
  isManagedLocalConfigPathInvalid: boolean;
  primaryCtaClass: string;
  onSelectPreset: (presetId: string) => void;
  onStart: () => void;
  onOpenDocUrl: (url: string) => void;
}

export const TunnelStartControls: React.FC<TunnelStartControlsProps> = ({
  tunnelMode,
  selectedPresetId,
  managedRemoteTunnelPresets,
  selectedPreset,
  willReplaceActiveTunnel,
  state,
  isSavingMode,
  isManagedLocalConfigPathInvalid,
  primaryCtaClass,
  onSelectPreset,
  onStart,
  onOpenDocUrl,
}) => {
  return (
    <div data-settings-item="tunnel.start" className="space-y-6">
      <div className="rounded-lg border border-[var(--status-info-border)] bg-[var(--status-info-background)] p-3">
        <div className="flex items-start gap-2">
          <Icon
            name="information"
            className="mt-0.5 size-4 shrink-0 text-[var(--status-info)]"
          />
          <div className="space-y-1">
            {tunnelMode === 'managed-remote' && (
              <>
                <p className="typography-meta text-[var(--status-info)]">
                  {
                    'Managed remote tunnels require a purchased domain in your Cloudflare account.'
                  }
                </p>
                <button
                  type="button"
                  className="typography-meta inline-flex items-center gap-1 text-[var(--status-info)] underline underline-offset-2 hover:opacity-90"
                  onClick={() => {
                    onOpenDocUrl(MANAGED_REMOTE_TUNNEL_DOC_URL);
                  }}
                >
                  {'Check documentation on how to configure a managed remote tunnel'}
                  <Icon name="external-link" className="size-3.5" />
                </button>
              </>
            )}
            {tunnelMode === 'managed-local' && (
              <>
                <p className="typography-meta text-[var(--status-info)]">
                  {'Managed local tunnels use your local cloudflared configuration file.'}
                </p>
                <button
                  type="button"
                  className="typography-meta inline-flex items-center gap-1 text-[var(--status-info)] underline underline-offset-2 hover:opacity-90"
                  onClick={() => {
                    onOpenDocUrl(MANAGED_LOCAL_TUNNEL_DOC_URL);
                  }}
                >
                  {'Check documentation on managed local tunnel configuration'}
                  <Icon name="external-link" className="size-3.5" />
                </button>
              </>
            )}
            <p className="typography-meta text-[var(--status-info)]">
              {`Start a ${
                TUNNEL_MODE_OPTIONS.find((option) => option.value === tunnelMode)?.label ??
                'Quick'
              } tunnel and generate a one-time connect link. Do not close the app while this tunnel is in use.`}
            </p>
          </div>
        </div>
      </div>

      {tunnelMode === 'managed-remote' && (
        <div className="space-y-1.5">
          <p className={SETTINGS_FIELD_LABEL_CLASS}>
            {'Managed remote tunnel to connect'}
          </p>
          <Select
            value={selectedPresetId || (managedRemoteTunnelPresets[0]?.id ?? '')}
            onValueChange={onSelectPreset}
            disabled={
              isSavingMode ||
              state === 'starting' ||
              state === 'stopping' ||
              managedRemoteTunnelPresets.length <= 1
            }
          >
            <SelectTrigger size={SETTINGS_SELECT_SIZE}>
              <SelectValue placeholder={'Select saved tunnel'}>
                {selectedPreset?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent fitContent>
              {managedRemoteTunnelPresets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {willReplaceActiveTunnel && (
        <div className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
          <div className="flex items-start gap-2">
            <Icon
              name="error-warning"
              className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]"
            />
            <p className="typography-meta text-[var(--status-warning)]">
              {
                'Starting this tunnel replaces the active tunnel and revokes existing connect links and remote sessions.'
              }
            </p>
          </div>
        </div>
      )}

      <Button
        size="sm"
        variant="outline"
        onClick={onStart}
        disabled={
          state === 'starting' ||
          isSavingMode ||
          (tunnelMode === 'managed-remote' && !selectedPreset) ||
          (tunnelMode === 'managed-local' && isManagedLocalConfigPathInvalid)
        }
        className={cn(primaryCtaClass, state === 'starting' && 'opacity-70')}
      >
        {state === 'starting' ? (
          <>
            <Icon name="loader-4" className="size-3.5 animate-spin" />{' '}
            {'Starting tunnel...'}
          </>
        ) : (
          'Start Tunnel'
        )}
      </Button>
    </div>
  );
};
