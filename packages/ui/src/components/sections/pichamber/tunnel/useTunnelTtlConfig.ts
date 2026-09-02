import React from 'react';
import { toast } from '@/components/ui';
import { updateDesktopSettings } from '@/lib/persistence';
import { BOOTSTRAP_TTL_OPTIONS, SESSION_TTL_OPTIONS } from './tunnelHelpers';

export function useTunnelTtlConfig() {
  const [bootstrapTtlMs, setBootstrapTtlMs] = React.useState<number | null>(30 * 60 * 1000);
  const [sessionTtlMs, setSessionTtlMs] = React.useState<number>(8 * 60 * 60 * 1000);
  const [isSavingTtl, setIsSavingTtl] = React.useState(false);

  const saveTtlSettings = React.useCallback(
    async (nextBootstrapTtlMs: number | null, nextSessionTtlMs: number) => {
      setIsSavingTtl(true);
      try {
        await updateDesktopSettings({
          tunnelBootstrapTtlMs: nextBootstrapTtlMs,
          tunnelSessionTtlMs: nextSessionTtlMs,
        });
      } catch {
        toast.error('Failed to save tunnel TTL settings');
      } finally {
        setIsSavingTtl(false);
      }
    },
    [],
  );

  const handleBootstrapTtlChange = React.useCallback(
    async (value: string) => {
      const option = BOOTSTRAP_TTL_OPTIONS.find((entry) => entry.value === value);
      if (!option) {
        return;
      }
      setBootstrapTtlMs(option.ms);
      await saveTtlSettings(option.ms, sessionTtlMs);
    },
    [saveTtlSettings, sessionTtlMs],
  );

  const handleSessionTtlChange = React.useCallback(
    async (value: string) => {
      const option = SESSION_TTL_OPTIONS.find((entry) => entry.value === value);
      if (!option || option.ms === null) {
        return;
      }
      setSessionTtlMs(option.ms);
      await saveTtlSettings(bootstrapTtlMs, option.ms);
    },
    [bootstrapTtlMs, saveTtlSettings],
  );

  return {
    bootstrapTtlMs,
    setBootstrapTtlMs,
    sessionTtlMs,
    setSessionTtlMs,
    isSavingTtl,
    saveTtlSettings,
    handleBootstrapTtlChange,
    handleSessionTtlChange,
  };
}
