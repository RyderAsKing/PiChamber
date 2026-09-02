import React from 'react';
import QRCode from 'qrcode';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { updateDesktopSettings } from '@/lib/persistence';
import { openExternalUrl } from '@/lib/url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import type {
  ManagedRemoteTunnelPreset,
  TunnelCheckResponse,
  TunnelDependencyInstallInfo,
  TunnelInfo,
  TunnelMode,
  TunnelProviderCapability,
  TunnelSessionRecord,
  TunnelStartResponse,
  TunnelState,
  TunnelStatusResponse,
} from './tunnelTypes';
import {
  BOOTSTRAP_TTL_OPTIONS,
  createTunnelDependencyInstallInfo,
  formatRemaining,
  hasAllowedManagedLocalConfigExtension,
  normalizePresetHostname,
  sanitizePresets,
  SESSION_TTL_OPTIONS,
  toUiTunnelMode,
  TUNNEL_MODE_OPTIONS,
} from './tunnelHelpers';
import { useTunnelPresetsState } from './useTunnelPresetsState';
import { useManagedLocalConfig } from './useManagedLocalConfig';

export function useTunnelSettingsState() {
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [state, setState] = React.useState<TunnelState>('checking');
  const [tunnelInfo, setTunnelInfo] = React.useState<TunnelInfo | null>(null);
  const [activeTunnelMode, setActiveTunnelMode] = React.useState<TunnelMode | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [managedRemoteValidationError, setManagedRemoteValidationError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [isSavingTtl, setIsSavingTtl] = React.useState(false);
  const [isSavingMode, setIsSavingMode] = React.useState(false);
  const [tunnelProvider, setTunnelProvider] = React.useState<string>('cloudflare');
  const [dependencyInstallInfo, setDependencyInstallInfo] = React.useState<TunnelDependencyInstallInfo>(() =>
    createTunnelDependencyInstallInfo('cloudflare')
  );
  const [providerCapabilities, setProviderCapabilities] = React.useState<TunnelProviderCapability[]>([]);
  const [tunnelMode, setTunnelMode] = React.useState<TunnelMode>('quick');
  const [bootstrapTtlMs, setBootstrapTtlMs] = React.useState<number | null>(30 * 60 * 1000);
  const [sessionTtlMs, setSessionTtlMs] = React.useState<number>(8 * 60 * 60 * 1000);
  const [remainingText, setRemainingText] = React.useState<string>('');
  const [sessionRecords, setSessionRecords] = React.useState<TunnelSessionRecord[]>([]);
  const [nowTs, setNowTs] = React.useState<number>(() => Date.now());
  const [localPort, setLocalPort] = React.useState<number | null>(null);

  const saveTunnelSettings = React.useCallback(
    async (payload: {
      tunnelProvider?: string;
      tunnelMode?: TunnelMode;
      managedLocalTunnelConfigPath?: string | null;
      managedRemoteTunnelPresets?: ManagedRemoteTunnelPreset[];
      managedRemoteTunnelPresetTokens?: Record<string, string>;
      tunnelBootstrapTtlMs?: number | null;
      tunnelSessionTtlMs?: number;
    }) => {
      setIsSavingMode(true);
      try {
        await updateDesktopSettings(payload);
        if (Object.prototype.hasOwnProperty.call(payload, 'tunnelMode') && payload.tunnelMode) {
          setTunnelMode(payload.tunnelMode);
        }
        if (
          Object.prototype.hasOwnProperty.call(payload, 'tunnelProvider') &&
          typeof payload.tunnelProvider === 'string'
        ) {
          setTunnelProvider(payload.tunnelProvider);
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'managedLocalTunnelConfigPath')) {
          setManagedLocalConfigPath(payload.managedLocalTunnelConfigPath ?? null);
        }
        if (
          Object.prototype.hasOwnProperty.call(payload, 'managedRemoteTunnelPresets') &&
          payload.managedRemoteTunnelPresets
        ) {
          setManagedRemoteTunnelPresets(payload.managedRemoteTunnelPresets);
        }
      } catch {
        toast.error('Failed to save tunnel settings');
      } finally {
        setIsSavingMode(false);
      }
    },
    []
  );

  const presetsState = useTunnelPresetsState({
    saveTunnelSettings,
    setManagedRemoteValidationError,
  });

  const {
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
  } = presetsState;

  const localConfigState = useManagedLocalConfig({
    saveTunnelSettings,
  });

  const {
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
  } = localConfigState;

  const renderedSessionRecords = React.useMemo(() => {
    return sessionRecords.map((record) => {
      const isExpired = record.expiresAt <= nowTs;
      const isActive = record.status === 'active' && !isExpired;
      const remainingTextForSession = isActive
        ? formatRemaining(record.expiresAt - nowTs)
        : record.inactiveReason === 'expired' || isExpired
        ? 'expired'
        : 'inactive';
      const inactiveLabel =
        remainingTextForSession === 'expired'
          ? 'Expired'
          : record.inactiveReason === 'tunnel-revoked'
          ? 'Revoked'
          : 'Inactive';

      const mode = toUiTunnelMode(record.mode);
      return {
        ...record,
        isActive,
        mode,
        remainingTextForSession,
        inactiveLabel,
      };
    });
  }, [nowTs, sessionRecords]);

  const isConnectLinkLive = React.useMemo(() => {
    if (!tunnelInfo?.connectUrl) {
      return false;
    }
    if (tunnelInfo.bootstrapExpiresAt === null) {
      return true;
    }
    return tunnelInfo.bootstrapExpiresAt > nowTs;
  }, [nowTs, tunnelInfo?.bootstrapExpiresAt, tunnelInfo?.connectUrl]);

  const isSelectedModeTunnelReady = React.useMemo(() => {
    if (!tunnelInfo) {
      return false;
    }
    if (state !== 'active' && state !== 'stopping') {
      return false;
    }
    return activeTunnelMode === tunnelMode;
  }, [activeTunnelMode, state, tunnelInfo, tunnelMode]);

  const willReplaceActiveTunnel = React.useMemo(() => {
    if (!tunnelInfo || state !== 'active') {
      return false;
    }
    if (!activeTunnelMode) {
      return false;
    }
    return activeTunnelMode !== tunnelMode;
  }, [activeTunnelMode, state, tunnelInfo, tunnelMode]);

  const suggestedConnectorPort = React.useMemo(() => {
    if (typeof localPort === 'number' && Number.isFinite(localPort) && localPort > 0) {
      return localPort;
    }
    if (typeof window === 'undefined') {
      return null;
    }
    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    const portSource = runtimeApiBaseUrl || window.location.href;
    let parsed = 0;
    try {
      parsed = Number(new URL(portSource).port);
    } catch {
      parsed = Number(window.location.port);
    }
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return null;
  }, [localPort]);

  const selectedProviderCapability = React.useMemo(() => {
    return providerCapabilities.find((capability) => capability.provider === tunnelProvider) ?? null;
  }, [providerCapabilities, tunnelProvider]);

  const tunnelModeOptions = React.useMemo(() => {
    const supportedModes = new Set(
      selectedProviderCapability?.modes
        ?.map((mode) => mode.key)
        .filter((mode): mode is TunnelMode => mode === 'quick' || mode === 'managed-remote' || mode === 'managed-local')
    );
    if (supportedModes.size === 0) {
      return TUNNEL_MODE_OPTIONS;
    }
    return TUNNEL_MODE_OPTIONS.filter((option) => supportedModes.has(option.value));
  }, [selectedProviderCapability]);

  const providerSupportsManagedModes = React.useMemo(
    () => tunnelModeOptions.some((option) => option.value === 'managed-remote' || option.value === 'managed-local'),
    [tunnelModeOptions]
  );

  const displayedDependencyInstallInfo = React.useMemo(() => {
    if (dependencyInstallInfo.provider === tunnelProvider) {
      return dependencyInstallInfo;
    }
    return createTunnelDependencyInstallInfo(tunnelProvider);
  }, [dependencyInstallInfo, tunnelProvider]);

  const openExternal = React.useCallback(async (url: string) => {
    await openExternalUrl(url);
  }, []);

  const applyDependencyCheck = React.useCallback(
    (checkData: TunnelCheckResponse, fallbackProvider: string): boolean => {
      setDependencyInstallInfo(createTunnelDependencyInstallInfo(fallbackProvider, checkData));
      return checkData.available === true;
    },
    []
  );

  const checkAvailabilityAndStatus = React.useCallback(
    async (signal: AbortSignal) => {
      try {
        const [checkRes, statusRes, settingsRes, providersRes] = await Promise.all([
          runtimeFetch('/api/pichamber/tunnel/check', { signal }),
          runtimeFetch('/api/pichamber/tunnel/status', { signal }),
          runtimeFetch('/api/pi/ui-settings', { signal, headers: { Accept: 'application/json' } }),
          runtimeFetch('/api/pichamber/tunnel/providers', { signal }),
        ]);

        const checkData = (await checkRes.json()) as TunnelCheckResponse;
        const statusData = (await statusRes.json()) as TunnelStatusResponse;
        const settingsData = settingsRes.ok ? await settingsRes.json() : {};
        const providersData = providersRes.ok ? await providersRes.json() : {};

        const loadedBootstrapTtl =
          statusData.ttlConfig?.bootstrapTtlMs ??
          (settingsData?.tunnelBootstrapTtlMs === null
            ? null
            : typeof settingsData?.tunnelBootstrapTtlMs === 'number'
            ? settingsData.tunnelBootstrapTtlMs
            : 30 * 60 * 1000);
        const loadedSessionTtl =
          typeof statusData.ttlConfig?.sessionTtlMs === 'number'
            ? statusData.ttlConfig.sessionTtlMs
            : typeof settingsData?.tunnelSessionTtlMs === 'number'
            ? settingsData.tunnelSessionTtlMs
            : 8 * 60 * 60 * 1000;

        const loadedMode: TunnelMode = toUiTunnelMode(statusData.mode ?? settingsData?.tunnelMode);
        const loadedProvider = 'cloudflare';
        const loadedManagedLocalConfigPath =
          typeof settingsData?.managedLocalTunnelConfigPath === 'string'
            ? settingsData.managedLocalTunnelConfigPath.trim() || null
            : null;
        const dependencyAvailable = applyDependencyCheck(checkData, loadedProvider);

        const loadedPresetsFromStatus = sanitizePresets(statusData?.managedRemoteTunnelPresets);
        const loadedHostname =
          typeof statusData.managedRemoteTunnelHostname === 'string' ? statusData.managedRemoteTunnelHostname : '';
        const presets =
          loadedPresetsFromStatus.length > 0
            ? loadedPresetsFromStatus
            : loadedHostname
            ? [
                {
                  id: `legacy-${normalizePresetHostname(loadedHostname)}`,
                  name: loadedHostname,
                  hostname: normalizePresetHostname(loadedHostname),
                },
              ]
            : [];

        const selectedId = presets[0]?.id || '';

        setBootstrapTtlMs(loadedBootstrapTtl);
        setSessionTtlMs(loadedSessionTtl);
        setTunnelProvider(loadedProvider);
        setProviderCapabilities(Array.isArray(providersData?.providers) ? providersData.providers : []);
        setTunnelMode(loadedMode);
        setManagedLocalConfigPath(loadedManagedLocalConfigPath);
        setManagedRemoteTunnelPresets(presets);
        setSelectedPresetId(selectedId);
        setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
        setActiveTunnelMode(
          statusData.activeTunnelMode
            ? toUiTunnelMode(statusData.activeTunnelMode)
            : statusData.active && statusData.mode
            ? toUiTunnelMode(statusData.mode)
            : null
        );
        setSavedTokenPresetIds(
          new Set(
            Array.isArray(statusData.managedRemoteTunnelTokenPresetIds)
              ? statusData.managedRemoteTunnelTokenPresetIds
              : []
          )
        );
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);

        if (statusData.active && statusData.url) {
          setTunnelInfo({
            url: statusData.url,
            connectUrl: null,
            bootstrapExpiresAt:
              typeof statusData.bootstrapExpiresAt === 'number' ? statusData.bootstrapExpiresAt : null,
          });
          setState('active');
          return;
        }

        setState(dependencyAvailable ? 'idle' : 'not-available');
      } catch {
        if (!signal.aborted) {
          setState('error');
          setErrorMessage('Failed to check tunnel availability');
        }
      }
    },
    [
      applyDependencyCheck,
      setManagedLocalConfigPath,
      setManagedRemoteTunnelPresets,
      setSavedTokenPresetIds,
      setSelectedPresetId,
    ]
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void checkAvailabilityAndStatus(controller.signal);
    return () => controller.abort();
  }, [checkAvailabilityAndStatus]);

  React.useEffect(() => {
    if (!tunnelInfo?.connectUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(tunnelInfo.connectUrl, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tunnelInfo?.connectUrl]);

  React.useEffect(() => {
    if (!tunnelInfo?.bootstrapExpiresAt) {
      setRemainingText('No expiry');
      return;
    }

    let rafId: number | null = null;
    let lastTime = Date.now();

    const updateRemaining = () => {
      const remaining = tunnelInfo.bootstrapExpiresAt ? tunnelInfo.bootstrapExpiresAt - Date.now() : 0;
      if (remaining <= 0) {
        setRemainingText('Expired');
      } else {
        setRemainingText(formatRemaining(remaining));
      }
    };

    const tick = () => {
      const now = Date.now();
      if (now - lastTime >= 1_000) {
        updateRemaining();
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    updateRemaining();

    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(tick);
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && rafId === null) {
        rafId = requestAnimationFrame(tick);
      } else if (document.visibilityState !== 'visible' && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [tunnelInfo?.bootstrapExpiresAt]);

  React.useEffect(() => {
    let rafId: number | null = null;
    let lastTime = Date.now();

    const tick = () => {
      const now = Date.now();
      if (now - lastTime >= 1_000) {
        setNowTs(now);
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(tick);
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && rafId === null) {
        rafId = requestAnimationFrame(tick);
      } else if (document.visibilityState !== 'visible' && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  React.useEffect(() => {
    if (state === 'starting' || state === 'stopping' || state === 'checking') {
      return;
    }

    let cancelled = false;
    const refreshSessions = async () => {
      try {
        const statusRes = await runtimeFetch('/api/pichamber/tunnel/status');
        if (!statusRes.ok || cancelled) {
          return;
        }
        const statusData = (await statusRes.json()) as TunnelStatusResponse;
        if (cancelled) {
          return;
        }
        setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
        setSavedTokenPresetIds(
          new Set(
            Array.isArray(statusData.managedRemoteTunnelTokenPresetIds)
              ? statusData.managedRemoteTunnelTokenPresetIds
              : []
          )
        );
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      } catch {
        // ignore transient refresh failures
      }
    };

    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void refreshSessions();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setSavedTokenPresetIds, state]);

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
    []
  );

  const handleStart = React.useCallback(async () => {
    setErrorMessage(null);
    setManagedRemoteValidationError(null);

    if (
      tunnelMode === 'managed-local' &&
      managedLocalConfigPath &&
      !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath)
    ) {
      setErrorMessage(managedLocalConfigExtensionError);
      toast.error(managedLocalConfigExtensionError);
      return;
    }

    setState('starting');

    try {
      let managedRemoteTunnelHostname = '';
      let managedRemoteTunnelToken = '';

      if (tunnelMode === 'managed-remote') {
        if (!selectedPreset) {
          setState('idle');
          setManagedRemoteValidationError('Select or add a managed remote tunnel first');
          toast.error('Select or add a managed remote tunnel first');
          return;
        }

        managedRemoteTunnelHostname = selectedPreset.hostname;
        managedRemoteTunnelToken = (sessionTokensByPresetId[selectedPreset.id] || '').trim();

        await saveTunnelSettings({
          tunnelMode: 'managed-remote',
          managedRemoteTunnelPresets,
        });
      }

      const res = await runtimeFetch('/api/pichamber/tunnel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: tunnelProvider,
          mode: tunnelMode,
          ...(tunnelMode === 'managed-remote' && selectedPreset
            ? {
                managedRemoteTunnelPresetId: selectedPreset.id,
                managedRemoteTunnelPresetName: selectedPreset.name,
              }
            : {}),
          ...(tunnelMode === 'managed-remote' && managedRemoteTunnelHostname
            ? { managedRemoteTunnelHostname }
            : {}),
          ...(tunnelMode === 'managed-remote' && managedRemoteTunnelToken ? { managedRemoteTunnelToken } : {}),
          ...(tunnelMode === 'managed-local' && managedLocalConfigPath ? { configPath: managedLocalConfigPath } : {}),
        }),
      });
      const data = (await res.json()) as TunnelStartResponse;

      if (!res.ok || !data.ok) {
        if (
          tunnelMode === 'managed-remote' &&
          typeof data.error === 'string' &&
          data.error.includes('Managed remote tunnel token is required')
        ) {
          setState('idle');
          setManagedRemoteValidationError('Managed remote tunnel token is required before starting');
          toast.error('Add a managed remote tunnel token before starting');
          return;
        }
        setState('error');
        setErrorMessage(data.error || 'Failed to start tunnel');
        toast.error(data.error || 'Failed to start tunnel');
        return;
      }

      const startedUrl = typeof data.url === 'string' ? data.url : '';
      if (!startedUrl) {
        setState('error');
        setErrorMessage('Tunnel started but no public URL was returned');
        toast.error('Tunnel started but no public URL was returned');
        return;
      }

      setTunnelInfo({
        url: startedUrl,
        connectUrl: typeof data.connectUrl === 'string' ? data.connectUrl : null,
        bootstrapExpiresAt: typeof data.bootstrapExpiresAt === 'number' ? data.bootstrapExpiresAt : null,
      });
      setActiveTunnelMode(
        data.activeTunnelMode
          ? toUiTunnelMode(data.activeTunnelMode)
          : data.mode
          ? toUiTunnelMode(data.mode)
          : tunnelMode
      );
      setSessionRecords(Array.isArray(data.activeSessions) ? data.activeSessions : []);
      if (Array.isArray(data.managedRemoteTunnelTokenPresetIds)) {
        setSavedTokenPresetIds(new Set(data.managedRemoteTunnelTokenPresetIds));
      }
      if (typeof data.localPort === 'number') {
        setLocalPort(data.localPort);
      }
      if (typeof data.mode === 'string') {
        setTunnelMode(toUiTunnelMode(data.mode));
      }
      setState('active');
      if (data.replacedTunnel) {
        const revokedBootstrapCount =
          typeof data.revokedBootstrapCount === 'number' ? data.revokedBootstrapCount : 0;
        const invalidatedSessionCount =
          typeof data.invalidatedSessionCount === 'number' ? data.invalidatedSessionCount : 0;
        if (revokedBootstrapCount === 1 && invalidatedSessionCount === 1) {
          toast.warning('Replaced previous tunnel: revoked 1 link, invalidated 1 session.');
        } else if (revokedBootstrapCount === 1) {
          toast.warning(`Replaced previous tunnel: revoked 1 link, invalidated ${invalidatedSessionCount} sessions.`);
        } else if (invalidatedSessionCount === 1) {
          toast.warning(`Replaced previous tunnel: revoked ${revokedBootstrapCount} links, invalidated 1 session.`);
        } else {
          toast.warning(
            `Replaced previous tunnel: revoked ${revokedBootstrapCount} links, invalidated ${invalidatedSessionCount} sessions.`
          );
        }
      } else {
        toast.success('Tunnel link ready');
      }
    } catch {
      setState('error');
      setErrorMessage('Failed to start tunnel');
      toast.error('Failed to start tunnel');
    }
  }, [
    managedLocalConfigExtensionError,
    managedLocalConfigPath,
    managedRemoteTunnelPresets,
    saveTunnelSettings,
    selectedPreset,
    sessionTokensByPresetId,
    setManagedRemoteValidationError,
    setSavedTokenPresetIds,
    tunnelMode,
    tunnelProvider,
  ]);

  const handleStop = React.useCallback(async () => {
    setState('stopping');

    try {
      await runtimeFetch('/api/pichamber/tunnel/stop', { method: 'POST' });
      const statusRes = await runtimeFetch('/api/pichamber/tunnel/status');
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as TunnelStatusResponse;
        setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
        setSavedTokenPresetIds(
          new Set(
            Array.isArray(statusData.managedRemoteTunnelTokenPresetIds)
              ? statusData.managedRemoteTunnelTokenPresetIds
              : []
          )
        );
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      }
      setTunnelInfo(null);
      setActiveTunnelMode(null);
      setQrDataUrl(null);
      setState('idle');
      toast.success('Tunnel stopped');
    } catch {
      setState('error');
      setErrorMessage('Failed to stop tunnel');
      toast.error('Failed to stop tunnel');
    }
  }, [setSavedTokenPresetIds]);

  const handleCopyUrl = React.useCallback(async () => {
    if (!tunnelInfo?.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(tunnelInfo.connectUrl);
      setCopied(true);
      toast.success('Connect link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [tunnelInfo?.connectUrl]);

  const handleBootstrapTtlChange = React.useCallback(
    async (value: string) => {
      const option = BOOTSTRAP_TTL_OPTIONS.find((entry) => entry.value === value);
      if (!option) {
        return;
      }
      setBootstrapTtlMs(option.ms);
      await saveTtlSettings(option.ms, sessionTtlMs);
    },
    [saveTtlSettings, sessionTtlMs]
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
    [bootstrapTtlMs, saveTtlSettings]
  );

  const handleModeChange = React.useCallback(
    async (value: TunnelMode) => {
      setManagedRemoteValidationError(null);
      setErrorMessage(null);
      if (state !== 'active' && state !== 'stopping' && state !== 'starting') {
        setState('idle');
      }

      await saveTunnelSettings({
        tunnelMode: value,
        managedRemoteTunnelPresets,
      });
    },
    [managedRemoteTunnelPresets, saveTunnelSettings, setManagedRemoteValidationError, state]
  );

  return {
    timeFormatPreference,
    state,
    tunnelInfo,
    activeTunnelMode,
    qrDataUrl,
    errorMessage,
    managedRemoteValidationError,
    setManagedRemoteValidationError,
    copied,
    isSavingTtl,
    isSavingMode,
    tunnelProvider,
    dependencyInstallInfo,
    providerCapabilities,
    tunnelMode,
    managedLocalConfigPath,
    managedRemoteTunnelPresets,
    expandedManagedRemoteTunnels,
    setExpandedManagedRemoteTunnels,
    selectedPresetId,
    sessionTokensByPresetId,
    setSessionTokensByPresetId,
    savedTokenPresetIds,
    isAddingPreset,
    setIsAddingPreset,
    newPresetName,
    setNewPresetName,
    newPresetHostname,
    setNewPresetHostname,
    newPresetToken,
    setNewPresetToken,
    bootstrapTtlMs,
    sessionTtlMs,
    remainingText,
    sessionRecords,
    nowTs,
    localPort,
    managedLocalConfigExtensionError,
    managedLocalConfigFileInputRef,
    isManagedLocalConfigPathInvalid,
    selectedPreset,
    renderedSessionRecords,
    isConnectLinkLive,
    isSelectedModeTunnelReady,
    willReplaceActiveTunnel,
    suggestedConnectorPort,
    selectedProviderCapability,
    tunnelModeOptions,
    providerSupportsManagedModes,
    displayedDependencyInstallInfo,
    openExternal,
    handleBrowseManagedLocalConfig,
    handleManagedLocalConfigInputChange,
    handleManagedLocalConfigInputBlur,
    handleManagedLocalConfigClear,
    handleManagedLocalConfigFileSelected,
    handleStart,
    handleStop,
    handleCopyUrl,
    handleBootstrapTtlChange,
    handleSessionTtlChange,
    handleModeChange,
    handleSelectPreset,
    handleSaveNewPreset,
    handleRemovePreset,
    persistManagedRemoteTunnelToken,
  };
}
