import React from 'react';
import { toast } from '@/components/ui';
import { requestFileAccess } from '@/lib/desktop';
import {
  hasAllowedManagedLocalConfigExtension,
  MANAGED_LOCAL_CONFIG_EXTENSION_ERROR_KEY,
} from './tunnelHelpers';

export interface UseManagedLocalConfigOptions {
  saveTunnelSettings: (payload: { managedLocalTunnelConfigPath?: string | null }) => Promise<void>;
}

export function useManagedLocalConfig({ saveTunnelSettings }: UseManagedLocalConfigOptions) {
  const [managedLocalConfigPath, setManagedLocalConfigPath] = React.useState<string | null>(null);
  const managedLocalConfigExtensionError = MANAGED_LOCAL_CONFIG_EXTENSION_ERROR_KEY;
  const managedLocalConfigFileInputRef = React.useRef<HTMLInputElement>(null);

  const isManagedLocalConfigPathInvalid = React.useMemo(() => {
    if (!managedLocalConfigPath) {
      return false;
    }
    return !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath);
  }, [managedLocalConfigPath]);

  const handleBrowseManagedLocalConfig = React.useCallback(async () => {
    const result = await requestFileAccess({
      filters: [{ name: 'Config', extensions: ['yml', 'yaml', 'json'] }],
    });

    if (result.success && typeof result.path === 'string' && result.path.trim().length > 0) {
      const nextPath = result.path.trim();
      if (!hasAllowedManagedLocalConfigExtension(nextPath)) {
        toast.error(managedLocalConfigExtensionError);
        return;
      }
      setManagedLocalConfigPath(nextPath);
      await saveTunnelSettings({ managedLocalTunnelConfigPath: nextPath });
      return;
    }

    managedLocalConfigFileInputRef.current?.click();
  }, [managedLocalConfigExtensionError, saveTunnelSettings]);

  const handleManagedLocalConfigInputChange = React.useCallback((value: string) => {
    const trimmed = value.trim();
    setManagedLocalConfigPath(trimmed.length > 0 ? trimmed : null);
  }, []);

  const handleManagedLocalConfigInputBlur = React.useCallback(async () => {
    if (managedLocalConfigPath && !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath)) {
      toast.error(managedLocalConfigExtensionError);
      return;
    }
    await saveTunnelSettings({ managedLocalTunnelConfigPath: managedLocalConfigPath });
  }, [managedLocalConfigExtensionError, managedLocalConfigPath, saveTunnelSettings]);

  const handleManagedLocalConfigClear = React.useCallback(async () => {
    setManagedLocalConfigPath(null);
    await saveTunnelSettings({ managedLocalTunnelConfigPath: null });
  }, [saveTunnelSettings]);

  const handleManagedLocalConfigFileSelected = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selected = event.target.files?.[0];
      if (!selected) {
        return;
      }

      const fallbackPath = selected.name.trim();
      if (fallbackPath.length === 0) {
        return;
      }
      if (!hasAllowedManagedLocalConfigExtension(fallbackPath)) {
        toast.error(managedLocalConfigExtensionError);
        return;
      }

      setManagedLocalConfigPath(fallbackPath);
      await saveTunnelSettings({ managedLocalTunnelConfigPath: fallbackPath });
      event.target.value = '';
    },
    [managedLocalConfigExtensionError, saveTunnelSettings]
  );

  return {
    managedLocalConfigPath,
    setManagedLocalConfigPath,
    managedLocalConfigExtensionError,
    managedLocalConfigFileInputRef,
    isManagedLocalConfigPathInvalid,
    handleBrowseManagedLocalConfig,
    handleManagedLocalConfigInputChange,
    handleManagedLocalConfigInputBlur,
    handleManagedLocalConfigClear,
    handleManagedLocalConfigFileSelected,
  };
}
