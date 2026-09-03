import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { SettingsGroupTitle } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ManagedRemoteTunnelPreset } from './tunnelTypes';

export interface ManagedRemoteTunnelsPanelProps {
  suggestedConnectorPort: number | null;
  managedRemoteTunnelPresets: ManagedRemoteTunnelPreset[];
  expandedManagedRemoteTunnels: Record<string, boolean>;
  sessionTokensByPresetId: Record<string, string>;
  savedTokenPresetIds: Set<string>;
  disabled: boolean;
  isAddingPreset: boolean;
  newPresetName: string;
  newPresetHostname: string;
  newPresetToken: string;
  managedRemoteValidationError: string | null;
  selectedPreset: ManagedRemoteTunnelPreset | null;
  onToggleAddPreset: () => void;
  onCancelAddPreset: () => void;
  onNewPresetNameChange: (val: string) => void;
  onNewPresetHostnameChange: (val: string) => void;
  onNewPresetTokenChange: (val: string) => void;
  onSaveNewPreset: () => void;
  onTogglePresetCollapse: (presetId: string, open: boolean) => void;
  onRemovePreset: (presetId: string) => void;
  onPresetTokenChange: (presetId: string, val: string) => void;
  onPersistToken: (params: {
    presetId: string;
    presetName: string;
    hostname: string;
    token: string;
  }) => void;
}

export const ManagedRemoteTunnelsPanel: React.FC<ManagedRemoteTunnelsPanelProps> = ({
  suggestedConnectorPort,
  managedRemoteTunnelPresets,
  expandedManagedRemoteTunnels,
  sessionTokensByPresetId,
  savedTokenPresetIds,
  disabled,
  isAddingPreset,
  newPresetName,
  newPresetHostname,
  newPresetToken,
  managedRemoteValidationError,
  selectedPreset,
  onToggleAddPreset,
  onCancelAddPreset,
  onNewPresetNameChange,
  onNewPresetHostnameChange,
  onNewPresetTokenChange,
  onSaveNewPreset,
  onTogglePresetCollapse,
  onRemovePreset,
  onPresetTokenChange,
  onPersistToken,
}) => {
  return (
    <div
      data-settings-item="tunnel.managed-remote"
      className="space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3"
    >
      {typeof suggestedConnectorPort === 'number' && (
        <div className="rounded-md border border-[var(--status-info-border)] bg-[var(--status-info-background)]/35 px-2 py-1.5">
          <p className="typography-meta text-[var(--status-info)]">
            {'Cloudflare connector target:'}{' '}
            <code>http://localhost:{suggestedConnectorPort}</code>
          </p>
        </div>
      )}

      <div className="mb-1 flex items-center justify-between gap-3">
        <SettingsGroupTitle>{'Saved managed remote tunnels'}</SettingsGroupTitle>
        <Button
          variant="ghost"
          size="xs"
          className="!font-normal"
          onClick={onToggleAddPreset}
          disabled={disabled}
        >
          <Icon name="add" className="h-3.5 w-3.5" />
          {'Create'}
        </Button>
      </div>

      {managedRemoteTunnelPresets.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-[var(--surface-subtle)]">
          {managedRemoteTunnelPresets.map((preset, index) => {
            const rowToken = sessionTokensByPresetId[preset.id] || '';
            const hasSavedToken = savedTokenPresetIds.has(preset.id);
            const isOpen = expandedManagedRemoteTunnels[preset.id] ?? false;

            return (
              <div
                key={preset.id}
                className={cn(
                  index < managedRemoteTunnelPresets.length - 1 &&
                    'border-b border-[var(--surface-subtle)]'
                )}
              >
                <Collapsible
                  open={isOpen}
                  onOpenChange={(open) => onTogglePresetCollapse(preset.id, open)}
                  className="py-1.5"
                >
                  <div className="flex items-start gap-2 px-3">
                    <CollapsibleTrigger
                      type="button"
                      className="group flex-1 justify-start gap-2 rounded-md px-0 py-1 pr-1 text-left hover:bg-[var(--interactive-hover)]"
                      disabled={disabled}
                    >
                      {isOpen ? (
                        <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="typography-ui-label min-w-0 flex-1 truncate text-foreground">
                        {preset.name}
                      </span>
                    </CollapsibleTrigger>

                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                      aria-label={`Remove ${preset.name}`}
                      onClick={() => onRemovePreset(preset.id)}
                      disabled={disabled}
                    >
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <CollapsibleContent className="pt-1.5">
                    <div className="space-y-1 px-3 pb-2">
                      <p className="typography-meta text-muted-foreground/70">
                        {'Hostname:'} <code>{preset.hostname}</code>
                      </p>
                      <Input
                        type="password"
                        value={rowToken}
                        onChange={(event) => onPresetTokenChange(preset.id, event.target.value)}
                        onBlur={(event) => {
                          const tokenToSave = event.currentTarget.value.trim();
                          if (!tokenToSave) return;
                          onPersistToken({
                            presetId: preset.id,
                            presetName: preset.name,
                            hostname: preset.hostname,
                            token: tokenToSave,
                          });
                        }}
                        placeholder={
                          hasSavedToken
                            ? 'Saved token available (optional to replace)'
                            : 'Paste token for this tunnel'
                        }
                        className="h-7"
                        disabled={disabled}
                      />
                      <div className="flex items-center justify-end">
                        <Button
                          variant="ghost"
                          size="xs"
                          className="!font-normal"
                          disabled={disabled || rowToken.trim().length === 0}
                          onClick={() => {
                            onPersistToken({
                              presetId: preset.id,
                              presetName: preset.name,
                              hostname: preset.hostname,
                              token: rowToken,
                            });
                          }}
                        >
                          {'Save token'}
                        </Button>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="typography-meta text-muted-foreground/70">
          {'No managed remote tunnels saved yet.'}
        </p>
      )}

      {isAddingPreset && (
        <div className="space-y-2 rounded-md border border-[var(--surface-subtle)] p-2">
          <Input
            value={newPresetName}
            onChange={(event) => onNewPresetNameChange(event.target.value)}
            placeholder={'Tunnel name (e.g. Production)'}
            className="h-7"
            disabled={disabled}
          />
          <Input
            value={newPresetHostname}
            onChange={(event) => onNewPresetHostnameChange(event.target.value)}
            placeholder={'Hostname (e.g. oc.example.com)'}
            className="h-7"
            disabled={disabled}
          />
          <Input
            type="password"
            value={newPresetToken}
            onChange={(event) => onNewPresetTokenChange(event.target.value)}
            placeholder={'Token'}
            className="h-7"
            disabled={disabled}
          />
          {typeof suggestedConnectorPort === 'number' && (
            <p className="typography-meta text-muted-foreground/70">
              {'For Cloudflare connector target, use'}{' '}
              <code>http://localhost:{suggestedConnectorPort}</code>.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="xs"
              className="!font-normal"
              onClick={onSaveNewPreset}
              disabled={disabled}
            >
              {'Save Changes'}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="!font-normal"
              onClick={onCancelAddPreset}
              disabled={disabled}
            >
              {'Cancel'}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <p className="typography-meta text-muted-foreground/80">
          {'Tokens are saved per tunnel and reused from disk.'}
        </p>
        <SettingsInfoHint>
          {'Tokens are saved in ~/.config/pichamber/cloudflare-managed-remote-tunnels.json.'}
        </SettingsInfoHint>
      </div>

      {!selectedPreset && managedRemoteValidationError && (
        <p className="typography-meta text-[var(--status-error)]">
          {managedRemoteValidationError}
        </p>
      )}
    </div>
  );
};
