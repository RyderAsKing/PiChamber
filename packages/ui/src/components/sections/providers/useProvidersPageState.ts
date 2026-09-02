import React from 'react';
import { toast } from '@/components/ui';
import { piClient } from '@/lib/pi/client';
import { PI_CUSTOM_PROVIDER_SELECTION, usePiProviderSelectionStore } from '@/lib/pi/provider-selection';
import type { PiProviderLoginState } from '@/lib/pi/protocol';
import type { PiProvider, PiThinkingLevel } from '@/lib/pi/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { reportSettingsSaveState } from '@/lib/persistence';
import { thinkingModelKey } from '@/lib/pi/thinking';
import { providerScope, sortProviders } from './ProviderModelRow';
import type { CustomProviderPersistPlan } from './custom-provider-form';

export function useProvidersPageState() {
  const selectedProviderId = usePiProviderSelectionStore((state) => state.selectedProviderId);
  const setSelectedProviderId = usePiProviderSelectionStore((state) => state.setSelectedProviderId);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);
  const settingsDefaultThinkingByModel = useConfigStore((state) => state.settingsDefaultThinkingByModel);
  const setSettingsDefaultThinkingByModel = useConfigStore((state) => state.setSettingsDefaultThinkingByModel);
  const setSettingsDefaultThinking = useConfigStore((state) => state.setSettingsDefaultThinking);

  const [providers, setProviders] = React.useState<readonly PiProvider[] | null>(null);
  const [apiKey, setApiKey] = React.useState('');
  const [promptValue, setPromptValue] = React.useState('');
  const [login, setLogin] = React.useState<PiProviderLoginState | null>(null);
  const [customEditing, setCustomEditing] = React.useState(false);
  const [providerConfig, setProviderConfig] = React.useState<Awaited<ReturnType<typeof piClient.getProviderConfig>>['config']>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = React.useState(false);
  const [catalogRefreshFeedback, setCatalogRefreshFeedback] = React.useState<'success' | 'error' | null>(null);
  const [thinkingBusyKeys, setThinkingBusyKeys] = React.useState<Set<string>>(new Set());
  const [providerQuery, setProviderQuery] = React.useState('');
  const [visibleCap, setVisibleCap] = React.useState(80);

  const refresh = React.useCallback(async () => {
    const { providers: result } = await piClient.listProviders(providerScope());
    setProviders(result);
    setFailed(false);
    void useConfigStore.getState().loadProviders({ source: 'providersPage:refresh' });
  }, []);

  const refreshProviders = React.useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { providers: result } = await piClient.refreshProviders(providerScope());
      setProviders(result);
      setFailed(false);
      const configStore = useConfigStore.getState();
      configStore.invalidateProviderCache();
      void configStore.loadProviders({ source: 'providersPage:refreshCatalog' });
      window.dispatchEvent(new CustomEvent('pichamber:providers-refreshed', { detail: result }));
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const refreshCatalog = React.useCallback(async () => {
    if (refreshingCatalog) return;
    setRefreshingCatalog(true);
    setCatalogRefreshFeedback(null);
    try {
      const { providers: result } = await piClient.refreshProviders(providerScope());
      setProviders(result);
      setFailed(false);
      setCatalogRefreshFeedback('success');
      const configStore = useConfigStore.getState();
      configStore.invalidateProviderCache();
      void configStore.loadProviders({ source: 'providersPage:refreshCatalog' });
      window.dispatchEvent(new CustomEvent('pichamber:providers-refreshed', { detail: result }));
      toast.success('Model catalog refreshed');
    } catch {
      setFailed(true);
      setCatalogRefreshFeedback('error');
      toast.error('Could not refresh model catalog');
    } finally {
      setRefreshingCatalog(false);
    }
  }, [refreshingCatalog]);

  React.useEffect(() => {
    let active = true;
    void refresh().catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  React.useEffect(() => {
    let active = true;
    const scope = providerScope();
    void piClient
      .getSettings(scope)
      .then((snapshot) => {
        if (!active) return;
        if (scope.runtimeKey !== getRuntimeKey()) return;
        const map = snapshot.pichamber.defaultThinkingByModel ?? {};
        const thinking = snapshot.pichamber.defaultThinking;
        const currentMap = useConfigStore.getState().settingsDefaultThinkingByModel;
        const mapsEqual = (() => {
          const aKeys = Object.keys(currentMap);
          const bKeys = Object.keys(map);
          if (aKeys.length !== bKeys.length) return false;
          for (const k of aKeys) if (currentMap[k] !== (map as Record<string, string>)[k]) return false;
          return true;
        })();
        if (!mapsEqual) setSettingsDefaultThinkingByModel(map as Record<string, string>);
        if (thinking !== useConfigStore.getState().settingsDefaultThinking) setSettingsDefaultThinking(thinking);
      })
      .catch(() => {
        // Preserve existing map on fetch failure — empty is not authoritative.
      });
    return () => {
      active = false;
    };
  }, [setSettingsDefaultThinking, setSettingsDefaultThinkingByModel]);

  React.useEffect(() => {
    if (!login || login.state !== 'pending') return;
    let active = true;
    const timer = window.setInterval(() => {
      void piClient
        .getProviderLogin(login.providerId, login.id, providerScope())
        .then((result) => {
          if (!active) return;
          setLogin(result.login);
          if (result.login.state === 'complete') void refresh().catch(() => setFailed(true));
        })
        .catch(() => {
          if (active)
            setLogin((current) =>
              current ? { ...current, state: 'failed', error: { code: 'PROVIDER_AUTH_REQUIRED' } } : current,
            );
        });
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [login, refresh]);

  React.useEffect(() => {
    if (!login || login.state !== 'complete' || !providers) return;
    const authed = providers.find((item) => item.id === login.providerId)?.authenticated === true;
    if (authed) setLogin(null);
  }, [login, providers]);

  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as readonly PiProvider[] | undefined;
      if (!Array.isArray(detail)) return;
      setProviders(detail);
      setFailed(false);
    };
    window.addEventListener('pichamber:providers-refreshed', handler as EventListener);
    return () => window.removeEventListener('pichamber:providers-refreshed', handler as EventListener);
  }, []);

  const provider = providers?.find((item) => item.id === selectedProviderId) ?? null;
  const providerId = provider?.id;

  React.useEffect(() => {
    if (!providerId) {
      setProviderConfig(null);
      return;
    }
    let active = true;
    void piClient
      .getProviderConfig(providerId, providerScope())
      .then((result) => {
        if (active) setProviderConfig(result.config);
      })
      .catch(() => {
        if (active) setProviderConfig(null);
      });
    return () => {
      active = false;
    };
  }, [providerId]);

  const persistThinkingForModel = React.useCallback(
    async (pId: string, mId: string, level: PiThinkingLevel | null) => {
      const key = thinkingModelKey({ providerId: pId, modelId: mId });
      if (!key) return;
      const scope = providerScope();
      const previousMap = useConfigStore.getState().settingsDefaultThinkingByModel;
      const optimisticMap: Record<string, string> = { ...previousMap };
      if (level === null) delete optimisticMap[key];
      else optimisticMap[key] = level;
      setSettingsDefaultThinkingByModel(optimisticMap);
      setThinkingBusyKeys((prev) => new Set(prev).add(key));
      reportSettingsSaveState('saving');
      try {
        const result = await piClient.setPiChamberDefaults({ defaultThinkingByModel: { [key]: level } }, scope);
        if (scope.runtimeKey !== getRuntimeKey()) {
          setSettingsDefaultThinkingByModel(previousMap);
          return;
        }
        const nextMap = (result.pichamber.defaultThinkingByModel ?? {}) as Record<string, string>;
        setSettingsDefaultThinkingByModel(nextMap);
        if (result.pichamber.defaultThinking !== undefined) setSettingsDefaultThinking(result.pichamber.defaultThinking);
        reportSettingsSaveState('saved');
      } catch {
        if (scope.runtimeKey === getRuntimeKey()) setSettingsDefaultThinkingByModel(previousMap);
        reportSettingsSaveState('error');
      } finally {
        setThinkingBusyKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [setSettingsDefaultThinking, setSettingsDefaultThinkingByModel],
  );

  const handleThinkingChange = React.useCallback(
    (pId: string, mId: string, level: PiThinkingLevel | null) => {
      void persistThinkingForModel(pId, mId, level);
    },
    [persistThinkingForModel],
  );

  const handleToggleHidden = React.useCallback(
    (pId: string, mId: string) => {
      toggleHiddenModel(pId, mId);
    },
    [toggleHiddenModel],
  );

  React.useEffect(() => {
    setVisibleCap(80);
  }, [providerId]);

  const displayModels = React.useMemo(() => {
    if (!provider) return [];
    return provider.models.slice(0, visibleCap);
  }, [provider, visibleCap]);
  const hasMore = provider ? provider.models.length > displayModels.length : false;

  const sortedProviders = React.useMemo(() => {
    if (!providers) return [];
    return sortProviders(providers);
  }, [providers]);

  const filteredProviders = React.useMemo(() => {
    const q = providerQuery.trim().toLowerCase();
    if (!q) return sortedProviders;
    return sortedProviders.filter((p) => {
      const label = p.label.toLowerCase();
      const id = p.id.toLowerCase();
      return label.includes(q) || id.includes(q);
    });
  }, [sortedProviders, providerQuery]);

  const saveCustomProvider = async (plan: CustomProviderPersistPlan) => {
    setBusy(true);
    try {
      await piClient.setProviderModels(
        {
          providerId: plan.providerID,
          label: plan.name,
          baseUrl: plan.config.options.baseURL,
          api: 'openai-completions',
          models: Object.entries(plan.config.models).map(([id, model]) => ({
            id,
            providerId: plan.providerID,
            label: model.name,
          })),
          ...(plan.config.options.headers ? { headers: plan.config.options.headers } : {}),
          ...(plan.config.env?.[0] ? { apiKeyReference: `{env:${plan.config.env[0]}}` } : {}),
        },
        providerScope(),
      );
      if (plan.apiKey)
        setLogin(
          (
            await piClient.loginProvider(
              { providerId: plan.providerID, type: 'api_key', apiKey: plan.apiKey },
              providerScope(),
            )
          ).login,
        );
      setSelectedProviderId(plan.providerID);
      setCustomEditing(false);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const startLogin = async (type: 'api_key' | 'oauth') => {
    if (!provider || busy || (type === 'api_key' && apiKey.trim().length === 0)) return;
    setBusy(true);
    try {
      const result = await piClient.loginProvider(
        { providerId: provider.id, type, ...(type === 'api_key' ? { apiKey: apiKey.trim() } : {}) },
        providerScope(),
      );
      setApiKey('');
      setPromptValue('');
      setLogin(result.login);
      if (result.login.state === 'complete') await refresh();
    } catch {
      setLogin({ id: '', providerId: provider.id, state: 'failed', error: { code: 'PROVIDER_AUTH_REQUIRED' } });
    } finally {
      setBusy(false);
    }
  };

  const submitPrompt = async () => {
    if (!login || !login.prompt || promptValue.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await piClient.respondProviderLogin(login.providerId, login.id, promptValue, providerScope());
      setPromptValue('');
      setLogin(result.login);
      if (result.login.state === 'complete') await refresh();
    } catch {
      setLogin((current) => (current ? { ...current, state: 'failed', error: { code: 'PROVIDER_AUTH_REQUIRED' } } : current));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (!provider || busy) return;
    setBusy(true);
    try {
      await piClient.logoutProvider({ providerId: provider.id }, providerScope());
      setLogin(null);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return {
    selectedProviderId,
    setSelectedProviderId,
    hiddenModels,
    toggleHiddenModel,
    hideAllModels,
    showAllModels,
    settingsDefaultThinkingByModel,
    setSettingsDefaultThinkingByModel,
    setSettingsDefaultThinking,
    providers,
    setProviders,
    apiKey,
    setApiKey,
    promptValue,
    setPromptValue,
    login,
    setLogin,
    customEditing,
    setCustomEditing,
    providerConfig,
    setProviderConfig,
    busy,
    setBusy,
    failed,
    setFailed,
    refreshing,
    setRefreshing,
    refreshingCatalog,
    setRefreshingCatalog,
    catalogRefreshFeedback,
    setCatalogRefreshFeedback,
    thinkingBusyKeys,
    setThinkingBusyKeys,
    providerQuery,
    setProviderQuery,
    visibleCap,
    setVisibleCap,
    refresh,
    refreshProviders,
    refreshCatalog,
    provider,
    providerId,
    sortedProviders,
    filteredProviders,
    displayModels,
    hasMore,
    saveCustomProvider,
    startLogin,
    submitPrompt,
    logout,
    handleThinkingChange,
    handleToggleHidden,
  };
}
