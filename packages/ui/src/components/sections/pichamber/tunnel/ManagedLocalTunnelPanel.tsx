import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SETTINGS_FIELD_LABEL_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface ManagedLocalTunnelPanelProps {
  managedLocalConfigPath: string | null;
  isManagedLocalConfigPathInvalid: boolean;
  managedLocalConfigExtensionError: string;
  disabled: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onInputChange: (value: string) => void;
  onInputBlur: () => void;
  onBrowse: () => void;
  onClear: () => void;
  onFileSelected: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export const ManagedLocalTunnelPanel: React.FC<ManagedLocalTunnelPanelProps> = ({
  managedLocalConfigPath,
  isManagedLocalConfigPathInvalid,
  managedLocalConfigExtensionError,
  disabled,
  fileInputRef,
  onInputChange,
  onInputBlur,
  onBrowse,
  onClear,
  onFileSelected,
}) => {
  return (
    <div
      data-settings-item="tunnel.managed-local-config"
      className="space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3"
    >
      <div className="space-y-1.5">
        <p className={SETTINGS_FIELD_LABEL_CLASS}>{'Configuration file'}</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yml,.yaml,.json"
          className="hidden"
          onChange={onFileSelected}
        />
        <div className="flex items-center gap-2">
          <Input
            value={managedLocalConfigPath || ''}
            onChange={(event) => onInputChange(event.target.value)}
            onBlur={onInputBlur}
            placeholder={'Using default cloudflared config'}
            className="h-7"
            disabled={disabled}
          />
          <Button
            variant="outline"
            size="xs"
            className="h-7 w-7 p-0"
            aria-label={'Browse config file'}
            onClick={onBrowse}
            disabled={disabled}
          >
            <Icon name="folder" className="size-3.5" />
          </Button>
          {managedLocalConfigPath && (
            <Button
              variant="ghost"
              size="xs"
              className="h-7 w-7 p-0"
              aria-label={'Clear config file'}
              onClick={onClear}
              disabled={disabled}
            >
              <Icon name="close" className="size-3.5" />
            </Button>
          )}
        </div>
        <p className="typography-meta text-muted-foreground/70">
          {managedLocalConfigPath
            ? 'Custom config file will be used when starting the tunnel.'
            : 'When empty, cloudflared uses its default config (~/.cloudflared/config.yml).'}
        </p>
        {isManagedLocalConfigPathInvalid && (
          <p className="typography-meta text-[var(--status-error)]">
            {managedLocalConfigExtensionError}
          </p>
        )}
      </div>
    </div>
  );
};
