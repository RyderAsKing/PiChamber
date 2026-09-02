import React from 'react';
import { toast } from '@/components/ui';
import { updateDesktopSettings } from '@/lib/persistence';
import type { ManagedRemoteTunnelPreset, TunnelMode } from './tunnelTypes';
import { createPresetId, normalizePresetHostname } from './tunnelHelpers';

export interface UseTunnelPresetsStateOptions {
  saveTunnelSettings: (payload: {
    tunnelMode?: TunnelMode;
    managedRemoteTunnelPresets?: ManagedRemoteTunnelPreset[];
    managedRemoteTunnelPresetTokens?: Record<string, string>;
  }) => Promise<void>;
  setManagedRemoteValidationError: (error: string | null) => void;
}

export function useTunnelPresetsState({
  saveTunnelSettings,
  setManagedRemoteValidationError,
}: UseTunnelPresetsStateOptions) {
  const [managedRemoteTunnelPresets, setManagedRemoteTunnelPresets] = React.useState<ManagedRemoteTunnelPreset[]>([]);
  const [expandedManagedRemoteTunnels, setExpandedManagedRemoteTunnels] = React.useState<Record<string, boolean>>({});
  const [selectedPresetId, setSelectedPresetId] = React.useState<string>('');
  const [sessionTokensByPresetId, setSessionTokensByPresetId] = React.useState<Record<string, string>>({});
  const [savedTokenPresetIds, setSavedTokenPresetIds] = React.useState<Set<string>>(new Set());
  const [isAddingPreset, setIsAddingPreset] = React.useState(false);
  const [newPresetName, setNewPresetName] = React.useState('');
  const [newPresetHostname, setNewPresetHostname] = React.useState('');
  const [newPresetToken, setNewPresetToken] = React.useState('');

  const selectedPreset = React.useMemo(
    () =>
      managedRemoteTunnelPresets.find((preset) => preset.id === selectedPresetId) ||
      managedRemoteTunnelPresets[0] ||
      null,
    [managedRemoteTunnelPresets, selectedPresetId]
  );

  const persistManagedRemoteTunnelToken = React.useCallback(
    async (payload: { presetId: string; presetName: string; hostname: string; token: string }) => {
      const token = payload.token.trim();
      if (!token) {
        return;
      }

      try {
        const tokenMap = {
          ...sessionTokensByPresetId,
          [payload.presetId]: token,
        };
        await updateDesktopSettings({
          managedRemoteTunnelPresetTokens: tokenMap,
        });
        setSavedTokenPresetIds((prev) => {
          const next = new Set(prev);
          next.add(payload.presetId);
          return next;
        });
      } catch {
        toast.error('Failed to save managed remote tunnel token');
      }
    },
    [sessionTokensByPresetId]
  );

  const persistSelectedPreset = React.useCallback(
    async (_preset: ManagedRemoteTunnelPreset, presets: ManagedRemoteTunnelPreset[]) => {
      try {
        await updateDesktopSettings({
          managedRemoteTunnelPresets: presets,
        });
      } catch {
        toast.error('Failed to save selected managed remote tunnel');
      }
    },
    []
  );

  const handleSelectPreset = React.useCallback(
    (presetId: string) => {
      const preset = managedRemoteTunnelPresets.find((entry) => entry.id === presetId);
      if (!preset) {
        return;
      }

      setSelectedPresetId(preset.id);
      setManagedRemoteValidationError(null);
      void persistSelectedPreset(preset, managedRemoteTunnelPresets);
    },
    [managedRemoteTunnelPresets, persistSelectedPreset, setManagedRemoteValidationError]
  );

  const handleSaveNewPreset = React.useCallback(async () => {
    const name = newPresetName.trim();
    const hostname = normalizePresetHostname(newPresetHostname);
    const token = newPresetToken.trim();

    if (!name) {
      toast.error('Tunnel name is required');
      return;
    }
    if (!hostname) {
      toast.error('Managed remote tunnel hostname is required');
      return;
    }
    if (!token) {
      toast.error('Managed remote tunnel token is required');
      return;
    }

    if (managedRemoteTunnelPresets.some((preset) => preset.hostname === hostname)) {
      toast.error('This hostname already exists');
      return;
    }

    const nextPreset: ManagedRemoteTunnelPreset = {
      id: createPresetId(),
      name,
      hostname,
    };
    const nextPresets = [...managedRemoteTunnelPresets, nextPreset];

    setManagedRemoteTunnelPresets(nextPresets);
    setSelectedPresetId(nextPreset.id);
    setExpandedManagedRemoteTunnels((prev) => ({ ...prev, [nextPreset.id]: true }));
    setSessionTokensByPresetId((prev) => ({ ...prev, [nextPreset.id]: token }));
    setManagedRemoteValidationError(null);
    setIsAddingPreset(false);
    setNewPresetName('');
    setNewPresetHostname('');
    setNewPresetToken('');

    await saveTunnelSettings({
      tunnelMode: 'managed-remote',
      managedRemoteTunnelPresets: nextPresets,
      managedRemoteTunnelPresetTokens: {
        ...sessionTokensByPresetId,
        [nextPreset.id]: token,
      },
    });
    await persistManagedRemoteTunnelToken({
      presetId: nextPreset.id,
      presetName: nextPreset.name,
      hostname: nextPreset.hostname,
      token,
    });
    toast.success('Managed remote tunnel saved');
  }, [
    managedRemoteTunnelPresets,
    newPresetHostname,
    newPresetName,
    newPresetToken,
    persistManagedRemoteTunnelToken,
    saveTunnelSettings,
    sessionTokensByPresetId,
    setManagedRemoteValidationError,
  ]);

  const handleRemovePreset = React.useCallback(
    async (presetId: string) => {
      const preset = managedRemoteTunnelPresets.find((entry) => entry.id === presetId);
      if (!preset) {
        return;
      }

      const nextPresets = managedRemoteTunnelPresets.filter((entry) => entry.id !== preset.id);
      const fallbackSelectedId = nextPresets[0]?.id || '';
      const nextSelectedId = selectedPresetId === preset.id ? fallbackSelectedId : selectedPresetId;
      const nextTokenMap = Object.fromEntries(
        Object.entries(sessionTokensByPresetId).filter(
          ([id, tokenValue]) => id !== preset.id && tokenValue.trim().length > 0
        )
      );

      setManagedRemoteTunnelPresets(nextPresets);
      setSelectedPresetId(nextSelectedId);
      setExpandedManagedRemoteTunnels((prev) => {
        const next = { ...prev };
        delete next[preset.id];
        return next;
      });
      setSessionTokensByPresetId((prev) => {
        const next = { ...prev };
        delete next[preset.id];
        return next;
      });
      setSavedTokenPresetIds((prev) => {
        const next = new Set(prev);
        next.delete(preset.id);
        return next;
      });
      setManagedRemoteValidationError(null);

      await saveTunnelSettings({
        managedRemoteTunnelPresets: nextPresets,
        managedRemoteTunnelPresetTokens: nextTokenMap,
      });

      toast.success('Managed remote tunnel removed');
    },
    [
      managedRemoteTunnelPresets,
      saveTunnelSettings,
      selectedPresetId,
      sessionTokensByPresetId,
      setManagedRemoteValidationError,
    ]
  );

  return {
    managedRemoteTunnelPresets,
    setManagedRemoteTunnelPresets,
    expandedManagedRemoteTunnels,
    setExpandedManagedRemoteTunnels,
    selectedPresetId,
    setSelectedPresetId,
    sessionTokensByPresetId,
    setSessionTokensByPresetId,
    savedTokenPresetIds,
    setSavedTokenPresetIds,
    isAddingPreset,
    setIsAddingPreset,
    newPresetName,
    setNewPresetName,
    newPresetHostname,
    setNewPresetHostname,
    newPresetToken,
    setNewPresetToken,
    selectedPreset,
    persistManagedRemoteTunnelToken,
    handleSelectPreset,
    handleSaveNewPreset,
    handleRemovePreset,
  };
}
