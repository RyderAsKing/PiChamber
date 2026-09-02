import React from 'react';
import QRCode from 'qrcode';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { requestFileAccess } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsSection, SETTINGS_FIELD_LABEL_CLASS } from '@/components/sections/shared/SettingsSection';
import type {
  ApiTunnelMode,
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
} from './tunnel/tunnelTypes';
import {
  BOOTSTRAP_TTL_OPTIONS,
  createPresetId,
  createTunnelDependencyInstallInfo,
  formatRemaining,
  hasAllowedManagedLocalConfigExtension,
  MANAGED_LOCAL_CONFIG_EXTENSION_ERROR_KEY,
  normalizePresetHostname,
  sanitizePresets,
  SESSION_TTL_OPTIONS,
  toUiTunnelMode,
  TUNNEL_MODE_OPTIONS,
} from './tunnel/tunnelHelpers';
import { ProviderOptionLabel } from './tunnel/ProviderOptionLabel';
import { TunnelAccessLinksCard } from './tunnel/TunnelAccessLinksCard';
import { TunnelDependencyMissingCard } from './tunnel/TunnelDependencyMissingCard';
import { TunnelTtlControls } from './tunnel/TunnelTtlControls';
import { ManagedRemoteTunnelsPanel } from './tunnel/ManagedRemoteTunnelsPanel';
import { ManagedLocalTunnelPanel } from './tunnel/ManagedLocalTunnelPanel';
import { TunnelStartControls } from './tunnel/TunnelStartControls';
import { TunnelActiveCard } from './tunnel/TunnelActiveCard';

export const TunnelSettings: React.FC = () => {
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
  const [dependencyInstallInfo, setDependencyInstallInfo] = React.useState<TunnelDependencyInstallInfo>(() => createTunnelDependencyInstallInfo('cloudflare'));
  const [providerCapabilities, setProviderCapabilities] = React.useState<TunnelProviderCapability[]>([]);
  const [tunnelMode, setTunnelMode] = React.useState<TunnelMode>('quick');
  const [managedLocalConfigPath, setManagedLocalConfigPath] = React.useState<string | null>(null);
  const [managedRemoteTunnelPresets, setManagedRemoteTunnelPresets] = React.useState<ManagedRemoteTunnelPreset[]>([]);
  const [expandedManagedRemoteTunnels, setExpandedManagedRemoteTunnels] = React.useState<Record<string, boolean>>({});
  const [selectedPresetId, setSelectedPresetId] = React.useState<string>('');
  const [sessionTokensByPresetId, setSessionTokensByPresetId] = React.useState<Record<string, string>>({});
  const [savedTokenPresetIds, setSavedTokenPresetIds] = React.useState<Set<string>>(new Set());
  const [isAddingPreset, setIsAddingPreset] = React.useState(false);
  const [newPresetName, setNewPresetName] = React.useState('');
  const [newPresetHostname, setNewPresetHostname] = React.useState('');
  const [newPresetToken, setNewPresetToken] = React.useState('');
  const [bootstrapTtlMs, setBootstrapTtlMs] = React.useState<number | null>(30 * 60 * 1000);
  const [sessionTtlMs, setSessionTtlMs] = React.useState<number>(8 * 60 * 60 * 1000);
  const [remainingText, setRemainingText] = React.useState<string>('');
  const [sessionRecords, setSessionRecords] = React.useState<TunnelSessionRecord[]>([]);
  const [nowTs, setNowTs] = React.useState<number>(() => Date.now());
  const [localPort, setLocalPort] = React.useState<number | null>(null);
  const managedLocalConfigExtensionError = MANAGED_LOCAL_CONFIG_EXTENSION_ERROR_KEY;
  const managedLocalConfigFileInputRef = React.useRef<HTMLInputElement>(null);
  const isManagedLocalConfigPathInvalid = React.useMemo(() => {
    if (!managedLocalConfigPath) {
      return false;
    }
    return !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath);
  }, [managedLocalConfigPath]);

  const selectedPreset = React.useMemo(
    () => managedRemoteTunnelPresets.find((preset) => preset.id === selectedPresetId) || managedRemoteTunnelPresets[0] || null,
    [managedRemoteTunnelPresets, selectedPresetId]
  );
  const renderedSessionRecords = React.useMemo(() => {
    return sessionRecords.map((record) => {
      const isExpired = record.expiresAt <= nowTs;
      const isActive = record.status === 'active' && !isExpired;
      const remainingTextForSession = isActive
        ? formatRemaining(record.expiresAt - nowTs)
        : (record.inactiveReason === 'expired' || isExpired ? 'expired' : 'inactive');
      const inactiveLabel = remainingTextForSession === 'expired'
        ? "Expired"
        : (record.inactiveReason === 'tunnel-revoked'
          ? "Revoked"
          : "Inactive");

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
    [tunnelModeOptions],
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

  const applyDependencyCheck = React.useCallback((checkData: TunnelCheckResponse, fallbackProvider: string): boolean => {
    setDependencyInstallInfo(createTunnelDependencyInstallInfo(fallbackProvider, checkData));
    return checkData.available === true;
  }, []);

  const checkAvailabilityAndStatus = React.useCallback(async (signal: AbortSignal) => {
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

      const loadedBootstrapTtl = statusData.ttlConfig?.bootstrapTtlMs
        ?? (settingsData?.tunnelBootstrapTtlMs === null
          ? null
          : typeof settingsData?.tunnelBootstrapTtlMs === 'number'
            ? settingsData.tunnelBootstrapTtlMs
            : 30 * 60 * 1000);
      const loadedSessionTtl = typeof statusData.ttlConfig?.sessionTtlMs === 'number'
        ? statusData.ttlConfig.sessionTtlMs
        : typeof settingsData?.tunnelSessionTtlMs === 'number'
          ? settingsData.tunnelSessionTtlMs
          : 8 * 60 * 60 * 1000;

      const loadedMode: TunnelMode = toUiTunnelMode(statusData.mode ?? settingsData?.tunnelMode);
      const loadedProvider = 'cloudflare';
      const loadedManagedLocalConfigPath = typeof settingsData?.managedLocalTunnelConfigPath === 'string'
        ? settingsData.managedLocalTunnelConfigPath.trim() || null
        : null;
      const dependencyAvailable = applyDependencyCheck(checkData, loadedProvider);

      const loadedPresetsFromStatus = sanitizePresets(statusData?.managedRemoteTunnelPresets);
      const loadedHostname = typeof statusData.managedRemoteTunnelHostname === 'string'
        ? statusData.managedRemoteTunnelHostname
        : '';
      const presets = loadedPresetsFromStatus.length > 0
        ? loadedPresetsFromStatus
        : (loadedHostname
          ? [{
            id: `legacy-${normalizePresetHostname(loadedHostname)}`,
            name: loadedHostname,
            hostname: normalizePresetHostname(loadedHostname),
          }]
          : []);

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
          : (statusData.active && statusData.mode ? toUiTunnelMode(statusData.mode) : null)
      );
      setSavedTokenPresetIds(new Set(Array.isArray(statusData.managedRemoteTunnelTokenPresetIds) ? statusData.managedRemoteTunnelTokenPresetIds : []));
      setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);

      if (statusData.active && statusData.url) {
        setTunnelInfo({
          url: statusData.url,
          connectUrl: null,
          bootstrapExpiresAt: typeof statusData.bootstrapExpiresAt === 'number' ? statusData.bootstrapExpiresAt : null,
        });
        setState('active');
        return;
      }

      setState(dependencyAvailable ? 'idle' : 'not-available');
    } catch {
      if (!signal.aborted) {
        setState('error');
        setErrorMessage("Failed to check tunnel availability");
      }
    }
  }, [applyDependencyCheck]);

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
    }).then((dataUrl) => {
      if (!cancelled) {
        setQrDataUrl(dataUrl);
      }
    }).catch(() => {
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
      setRemainingText("No expiry");
      return;
    }

    let rafId: number | null = null;
    let lastTime = Date.now();
    
    const updateRemaining = () => {
      const remaining = tunnelInfo.bootstrapExpiresAt ? tunnelInfo.bootstrapExpiresAt - Date.now() : 0;
      if (remaining <= 0) {
        setRemainingText("Expired");
      } else {
        setRemainingText(formatRemaining(remaining));
      }
    };

    const tick = () => {
      const now = Date.now();
      // Update only once per second
      if (now - lastTime >= 1_000) {
        updateRemaining();
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    updateRemaining();
    
    // Only run when visible
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
  }, [ tunnelInfo?.bootstrapExpiresAt]);

  React.useEffect(() => {
    // Use requestAnimationFrame for smoother updates without setInterval overhead
    let rafId: number | null = null;
    let lastTime = Date.now();
    
    const tick = () => {
      const now = Date.now();
      // Update only once per second
      if (now - lastTime >= 1_000) {
        setNowTs(now);
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    
    // Only run when visible
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
        setSavedTokenPresetIds(new Set(Array.isArray(statusData.managedRemoteTunnelTokenPresetIds) ? statusData.managedRemoteTunnelTokenPresetIds : []));
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      } catch {
        // ignore transient refresh failures
      }
    };

    const timer = window.setInterval(() => {
      // Skip polling when tab is hidden
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void refreshSessions();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state]);

  const saveTunnelSettings = React.useCallback(async (payload: {
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
      if (Object.prototype.hasOwnProperty.call(payload, 'tunnelProvider') && typeof payload.tunnelProvider === 'string') {
        setTunnelProvider(payload.tunnelProvider);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'managedLocalTunnelConfigPath')) {
        setManagedLocalConfigPath(payload.managedLocalTunnelConfigPath ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'managedRemoteTunnelPresets') && payload.managedRemoteTunnelPresets) {
        setManagedRemoteTunnelPresets(payload.managedRemoteTunnelPresets);
      }
    } catch {
      toast.error("Failed to save tunnel settings");
    } finally {
      setIsSavingMode(false);
    }
  }, []);

  const saveTtlSettings = React.useCallback(async (nextBootstrapTtlMs: number | null, nextSessionTtlMs: number) => {
    setIsSavingTtl(true);
    try {
      await updateDesktopSettings({
        tunnelBootstrapTtlMs: nextBootstrapTtlMs,
        tunnelSessionTtlMs: nextSessionTtlMs,
      });
    } catch {
      toast.error("Failed to save tunnel TTL settings");
    } finally {
      setIsSavingTtl(false);
    }
  }, []);

  const persistManagedRemoteTunnelToken = React.useCallback(async (payload: {
    presetId: string;
    presetName: string;
    hostname: string;
    token: string;
  }) => {
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
      toast.error("Failed to save managed remote tunnel token");
    }
  }, [sessionTokensByPresetId]);

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

  const handleManagedLocalConfigFileSelected = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
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
  }, [managedLocalConfigExtensionError, saveTunnelSettings]);

  const handleStart = React.useCallback(async () => {
    setErrorMessage(null);
    setManagedRemoteValidationError(null);

    if (tunnelMode === 'managed-local' && managedLocalConfigPath && !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath)) {
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
          setManagedRemoteValidationError("Select or add a managed remote tunnel first");
          toast.error("Select or add a managed remote tunnel first");
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
          ...(tunnelMode === 'managed-remote' && selectedPreset ? {
            managedRemoteTunnelPresetId: selectedPreset.id,
            managedRemoteTunnelPresetName: selectedPreset.name,
          } : {}),
          ...(tunnelMode === 'managed-remote' && managedRemoteTunnelHostname ? { managedRemoteTunnelHostname } : {}),
          ...(tunnelMode === 'managed-remote' && managedRemoteTunnelToken ? { managedRemoteTunnelToken } : {}),
          ...(tunnelMode === 'managed-local' && managedLocalConfigPath ? { configPath: managedLocalConfigPath } : {}),
        }),
      });
      const data = (await res.json()) as TunnelStartResponse;

      if (!res.ok || !data.ok) {
        if (tunnelMode === 'managed-remote' && typeof data.error === 'string' && data.error.includes('Managed remote tunnel token is required')) {
          setState('idle');
          setManagedRemoteValidationError("Managed remote tunnel token is required before starting");
          toast.error("Add a managed remote tunnel token before starting");
          return;
        }
        setState('error');
        setErrorMessage(data.error || "Failed to start tunnel");
        toast.error(data.error || "Failed to start tunnel");
        return;
      }

      const startedUrl = typeof data.url === 'string' ? data.url : '';
      if (!startedUrl) {
        setState('error');
        setErrorMessage("Tunnel started but no public URL was returned");
        toast.error("Tunnel started but no public URL was returned");
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
          : (data.mode ? toUiTunnelMode(data.mode) : tunnelMode)
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
        const revokedBootstrapCount = typeof data.revokedBootstrapCount === 'number' ? data.revokedBootstrapCount : 0;
        const invalidatedSessionCount = typeof data.invalidatedSessionCount === 'number' ? data.invalidatedSessionCount : 0;
        if (revokedBootstrapCount === 1 && invalidatedSessionCount === 1) {
          toast.warning("Replaced previous tunnel: revoked 1 link, invalidated 1 session.");
        } else if (revokedBootstrapCount === 1) {
          toast.warning(`Replaced previous tunnel: revoked 1 link, invalidated ${invalidatedSessionCount} sessions.`);
        } else if (invalidatedSessionCount === 1) {
          toast.warning(`Replaced previous tunnel: revoked ${revokedBootstrapCount} links, invalidated 1 session.`);
        } else {
          toast.warning(`Replaced previous tunnel: revoked ${revokedBootstrapCount} links, invalidated ${invalidatedSessionCount} sessions.`);
        }
      } else {
        toast.success("Tunnel link ready");
      }
    } catch {
      setState('error');
      setErrorMessage("Failed to start tunnel");
      toast.error("Failed to start tunnel");
    }
  }, [
    managedLocalConfigExtensionError,
    managedRemoteTunnelPresets,
    saveTunnelSettings,
    selectedPreset,
    sessionTokensByPresetId,
    tunnelProvider,
    tunnelMode,
    managedLocalConfigPath,
  ]);

  const handleStop = React.useCallback(async () => {
    setState('stopping');

    try {
      await runtimeFetch('/api/pichamber/tunnel/stop', { method: 'POST' });
      const statusRes = await runtimeFetch('/api/pichamber/tunnel/status');
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as TunnelStatusResponse;
        setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
        setSavedTokenPresetIds(new Set(Array.isArray(statusData.managedRemoteTunnelTokenPresetIds) ? statusData.managedRemoteTunnelTokenPresetIds : []));
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      }
      setTunnelInfo(null);
      setActiveTunnelMode(null);
      setQrDataUrl(null);
      setState('idle');
      toast.success("Tunnel stopped");
    } catch {
      setState('error');
      setErrorMessage("Failed to stop tunnel");
      toast.error("Failed to stop tunnel");
    }
  }, []);

  const handleCopyUrl = React.useCallback(async () => {
    if (!tunnelInfo?.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(tunnelInfo.connectUrl);
      setCopied(true);
      toast.success("Connect link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy URL");
    }
  }, [ tunnelInfo?.connectUrl]);

  const handleBootstrapTtlChange = React.useCallback(async (value: string) => {
    const option = BOOTSTRAP_TTL_OPTIONS.find((entry) => entry.value === value);
    if (!option) {
      return;
    }
    setBootstrapTtlMs(option.ms);
    await saveTtlSettings(option.ms, sessionTtlMs);
  }, [saveTtlSettings, sessionTtlMs]);

  const handleSessionTtlChange = React.useCallback(async (value: string) => {
    const option = SESSION_TTL_OPTIONS.find((entry) => entry.value === value);
    if (!option || option.ms === null) {
      return;
    }
    setSessionTtlMs(option.ms);
    await saveTtlSettings(bootstrapTtlMs, option.ms);
  }, [bootstrapTtlMs, saveTtlSettings]);

  const handleModeChange = React.useCallback(async (value: TunnelMode) => {
    setManagedRemoteValidationError(null);
    setErrorMessage(null);
    if (state !== 'active' && state !== 'stopping' && state !== 'starting') {
      setState('idle');
    }

    await saveTunnelSettings({
      tunnelMode: value,
      managedRemoteTunnelPresets,
    });
  }, [managedRemoteTunnelPresets, saveTunnelSettings, state]);

  const persistSelectedPreset = React.useCallback(async (preset: ManagedRemoteTunnelPreset, presets: ManagedRemoteTunnelPreset[]) => {
    try {
      await updateDesktopSettings({
        managedRemoteTunnelPresets: presets,
      });
    } catch {
      toast.error("Failed to save selected managed remote tunnel");
    }
  }, []);

  const handleSelectPreset = React.useCallback((presetId: string) => {
    const preset = managedRemoteTunnelPresets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    setSelectedPresetId(preset.id);
    setManagedRemoteValidationError(null);
    void persistSelectedPreset(preset, managedRemoteTunnelPresets);
  }, [managedRemoteTunnelPresets, persistSelectedPreset]);

  const handleSaveNewPreset = React.useCallback(async () => {
    const name = newPresetName.trim();
    const hostname = normalizePresetHostname(newPresetHostname);
    const token = newPresetToken.trim();

    if (!name) {
      toast.error("Tunnel name is required");
      return;
    }
    if (!hostname) {
      toast.error("Managed remote tunnel hostname is required");
      return;
    }
    if (!token) {
      toast.error("Managed remote tunnel token is required");
      return;
    }

    if (managedRemoteTunnelPresets.some((preset) => preset.hostname === hostname)) {
      toast.error("This hostname already exists");
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
    toast.success("Managed remote tunnel saved");
  }, [managedRemoteTunnelPresets, newPresetHostname, newPresetName, newPresetToken, persistManagedRemoteTunnelToken, saveTunnelSettings, sessionTokensByPresetId]);

  const handleRemovePreset = React.useCallback(async (presetId: string) => {
    const preset = managedRemoteTunnelPresets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    const nextPresets = managedRemoteTunnelPresets.filter((entry) => entry.id !== preset.id);
    const fallbackSelectedId = nextPresets[0]?.id || '';
    const nextSelectedId = selectedPresetId === preset.id ? fallbackSelectedId : selectedPresetId;
    const nextTokenMap = Object.fromEntries(
      Object.entries(sessionTokensByPresetId)
        .filter(([id, tokenValue]) => id !== preset.id && tokenValue.trim().length > 0)
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

    toast.success("Managed remote tunnel removed");
  }, [managedRemoteTunnelPresets, saveTunnelSettings, selectedPresetId, sessionTokensByPresetId]);

  const primaryCtaClass = 'gap-2 border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)] hover:text-[var(--primary-foreground)]';

  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-busy-pulse" aria-label={"Loading"} />
      </div>
    );
  }

  return (
    <SettingsSection
      title={"External Tunnel"}
      info={(
        <div className="space-y-1">
          <p>{"Configure secure remote access with quick links or your own managed remote Cloudflare tunnel."}</p>
          <p>{"Secure tunnel access is enforced server-side."}</p>
          <p>{"Connect links are one-time and are revoked when tunnel stops or connect-link TTL expires."}</p>
        </div>
      )}
      divider={false}
    >
      <div className="space-y-6">
        <TunnelAccessLinksCard
          records={renderedSessionRecords}
          timeFormatPreference={timeFormatPreference}
        />

        {state === 'not-available' && (
          <TunnelDependencyMissingCard installInfo={displayedDependencyInstallInfo} />
        )}

        <section className="space-y-4 px-2 pb-2 pt-0">
          <div className="space-y-3">
            <div data-settings-item="tunnel.provider" className="space-y-1.5">
              <p className={SETTINGS_FIELD_LABEL_CLASS}>{"Provider"}</p>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <ProviderOptionLabel provider="cloudflare" />
              </div>
            </div>

            <div data-settings-item="tunnel.type" className="space-y-1.5">
              <p className={SETTINGS_FIELD_LABEL_CLASS}>{"Tunnel type"}</p>
              <div className="flex flex-wrap items-center gap-1">
                {tunnelModeOptions.map((option) => (
                  <Tooltip key={option.value}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="chip"
                        size="xs"
                        aria-pressed={tunnelMode === option.value}
                        className="!font-normal"
                        onClick={() => {
                          void handleModeChange(option.value);
                        }}
                        disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                      >
                        {option.label}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {option.tooltip}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>

          <TunnelTtlControls
            bootstrapTtlMs={bootstrapTtlMs}
            sessionTtlMs={sessionTtlMs}
            tunnelMode={tunnelMode}
            disabled={isSavingTtl || isSavingMode || state === 'starting' || state === 'stopping'}
            providerSupportsManagedModes={providerSupportsManagedModes}
            onBootstrapTtlChange={(value) => {
              void handleBootstrapTtlChange(value);
            }}
            onSessionTtlChange={(value) => {
              void handleSessionTtlChange(value);
            }}
          />

          {tunnelMode === 'managed-remote' && (
            <ManagedRemoteTunnelsPanel
              suggestedConnectorPort={suggestedConnectorPort}
              managedRemoteTunnelPresets={managedRemoteTunnelPresets}
              expandedManagedRemoteTunnels={expandedManagedRemoteTunnels}
              sessionTokensByPresetId={sessionTokensByPresetId}
              savedTokenPresetIds={savedTokenPresetIds}
              disabled={state === 'starting' || state === 'stopping' || isSavingMode}
              isAddingPreset={isAddingPreset}
              newPresetName={newPresetName}
              newPresetHostname={newPresetHostname}
              newPresetToken={newPresetToken}
              managedRemoteValidationError={managedRemoteValidationError}
              selectedPreset={selectedPreset}
              onToggleAddPreset={() => setIsAddingPreset((prev) => !prev)}
              onCancelAddPreset={() => {
                setIsAddingPreset(false);
                setNewPresetName('');
                setNewPresetHostname('');
                setNewPresetToken('');
              }}
              onNewPresetNameChange={setNewPresetName}
              onNewPresetHostnameChange={setNewPresetHostname}
              onNewPresetTokenChange={setNewPresetToken}
              onSaveNewPreset={() => {
                void handleSaveNewPreset();
              }}
              onTogglePresetCollapse={(presetId, open) => {
                setExpandedManagedRemoteTunnels((prev) => ({ ...prev, [presetId]: open }));
                if (open) {
                  void handleSelectPreset(presetId);
                }
              }}
              onRemovePreset={(presetId) => {
                void handleRemovePreset(presetId);
              }}
              onPresetTokenChange={(presetId, nextValue) => {
                setManagedRemoteValidationError(null);
                setSessionTokensByPresetId((prev) => ({ ...prev, [presetId]: nextValue }));
              }}
              onPersistToken={(params) => {
                void persistManagedRemoteTunnelToken(params);
              }}
            />
          )}

          {tunnelMode === 'managed-local' && (
            <ManagedLocalTunnelPanel
              managedLocalConfigPath={managedLocalConfigPath}
              isManagedLocalConfigPathInvalid={isManagedLocalConfigPathInvalid}
              managedLocalConfigExtensionError={managedLocalConfigExtensionError}
              disabled={state === 'starting' || state === 'stopping' || isSavingMode}
              fileInputRef={managedLocalConfigFileInputRef}
              onInputChange={handleManagedLocalConfigInputChange}
              onInputBlur={() => {
                void handleManagedLocalConfigInputBlur();
              }}
              onBrowse={() => {
                void handleBrowseManagedLocalConfig();
              }}
              onClear={() => {
                void handleManagedLocalConfigClear();
              }}
              onFileSelected={(event) => {
                void handleManagedLocalConfigFileSelected(event);
              }}
            />
          )}

          {!isSelectedModeTunnelReady && (
            <TunnelStartControls
              tunnelMode={tunnelMode}
              selectedPresetId={selectedPresetId}
              managedRemoteTunnelPresets={managedRemoteTunnelPresets}
              selectedPreset={selectedPreset}
              willReplaceActiveTunnel={willReplaceActiveTunnel}
              state={state}
              isSavingMode={isSavingMode}
              isManagedLocalConfigPathInvalid={isManagedLocalConfigPathInvalid}
              primaryCtaClass={primaryCtaClass}
              onSelectPreset={(presetId) => {
                void handleSelectPreset(presetId);
              }}
              onStart={handleStart}
              onOpenDocUrl={(url) => {
                void openExternal(url);
              }}
            />
          )}
        </section>

        {isSelectedModeTunnelReady && tunnelInfo && (
          <TunnelActiveCard
            tunnelInfo={tunnelInfo}
            isConnectLinkLive={isConnectLinkLive}
            copied={copied}
            onCopyUrl={handleCopyUrl}
            remainingText={remainingText}
            qrDataUrl={qrDataUrl}
            onNewConnectLink={handleStart}
            onStop={handleStop}
            stopping={state === 'stopping'}
            isSavingMode={isSavingMode}
            isManagedLocalConfigPathInvalid={isManagedLocalConfigPathInvalid}
            tunnelMode={tunnelMode}
            primaryCtaClass={primaryCtaClass}
          />
        )}

        {state === 'error' && errorMessage && (
          <section className="space-y-3 px-2 pb-2 pt-0">
            <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
            <Button size="sm" variant="ghost" onClick={handleStart}>{"Retry"}</Button>
          </section>
        )}
      </div>
    </SettingsSection>
  );
};
