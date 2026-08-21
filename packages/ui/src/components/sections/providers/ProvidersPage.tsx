import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { CustomProviderForm } from '@/components/sections/providers/CustomProviderForm';
import { SettingsFieldRow, SettingsSection, SETTINGS_SELECT_ROW_TRIGGER_CLASS, SETTINGS_SELECT_SIZE } from '@/components/sections/shared/SettingsSection';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { piClient } from '@/lib/pi/client';
import { PI_CUSTOM_PROVIDER_SELECTION, usePiProviderSelectionStore } from '@/lib/pi/provider-selection';
import { providerToCustomFormState, type CustomProviderPersistPlan } from './custom-provider-form';
import type { PiProviderLoginState } from '@/lib/pi/protocol';
import type { PiModel, PiProvider, PiThinkingLevel } from '@/lib/pi/types';
import { cn } from '@/lib/utils';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { reportSettingsSaveState } from '@/lib/persistence';
import {
  catalogThinkingLevels,
  isPiThinkingLevel,
  modelHasConfigurableThinking,
  PI_THINKING_LEVEL_LABELS,
  thinkingModelKey,
} from '@/lib/pi/thinking';

const providerScope = () => ({ runtimeKey: getRuntimeKey() });

const FALLBACK_THINKING = '__pi_fallback__';

const thinkingSelectOptions = (levels: PiThinkingLevel[], stored?: PiThinkingLevel): PiThinkingLevel[] => {
  const options = [...levels];
  if (stored && !options.includes(stored)) options.push(stored);
  return options;
};

type ProviderModel = PiModel & { contextWindow?: number; reasoning?: unknown };

interface ProviderModelRowProps {
  providerId: string;
  model: ProviderModel;
  storedLevel?: PiThinkingLevel;
  isBusy: boolean;
  isHidden: boolean;
  isConnected: boolean;
  onThinkingChange: (providerId: string, modelId: string, level: PiThinkingLevel | null) => void;
  onToggleHidden: (providerId: string, modelId: string) => void;
}

const ProviderModelRow = React.memo<ProviderModelRowProps>(({
  providerId,
  model,
  storedLevel,
  isBusy,
  isHidden,
  isConnected,
  onThinkingChange,
  onToggleHidden,
}) => {
  const levels = React.useMemo(() => catalogThinkingLevels(model), [model]);
  const hasConfigurable = React.useMemo(() => modelHasConfigurableThinking(levels), [levels]);
  const showThinking = hasConfigurable || storedLevel !== undefined;
  const options = React.useMemo(() => thinkingSelectOptions(levels, storedLevel), [levels, storedLevel]);
  const selectValue = storedLevel ?? FALLBACK_THINKING;

  return (
    <div className={cn('flex min-w-0 items-center gap-2 py-2', isHidden && 'opacity-60')}>
      <span className="min-w-0 flex-1 truncate typography-ui-label">{model.label || model.id}</span>
      {showThinking ? (
        <Select
          value={selectValue}
          onValueChange={(value) => onThinkingChange(providerId, model.id, value === FALLBACK_THINKING ? null : (value as PiThinkingLevel))}
          disabled={isBusy}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-[4.5rem] max-w-[8rem] shrink-0 border-0 bg-transparent px-1.5 shadow-none gap-1 text-muted-foreground hover:bg-muted hover:text-foreground data-[placeholder]:text-muted-foreground"
            aria-label={`Thinking for ${model.label || model.id}`}
          >
            <SelectValue>
              {(value) => {
                if (value === FALLBACK_THINKING) return "Default";
                if (value && isPiThinkingLevel(value)) return PI_THINKING_LEVEL_LABELS[value];
                return (value as string) ?? "";
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FALLBACK_THINKING}>Default</SelectItem>
            {options.map((level) => (
              <SelectItem key={level} value={level}>{PI_THINKING_LEVEL_LABELS[level]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {model.supportsThinking ? <Icon name="brain-ai-3" className="size-4 shrink-0 text-muted-foreground" aria-label="Reasoning" /> : null}
      {typeof model.contextWindow === 'number' ? <span className="shrink-0 typography-micro text-muted-foreground">{model.contextWindow}</span> : null}
      {isConnected ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onToggleHidden(providerId, model.id)}
          aria-label={isHidden ? 'Show model in pickers' : 'Hide model from pickers'}
          title={isHidden ? 'Show model in pickers' : 'Hide model from pickers'}
        >
          <Icon name={isHidden ? 'eye' : 'eye-off'} className="size-4" />
        </Button>
      ) : null}
    </div>
  );
});
ProviderModelRow.displayName = 'ProviderModelRow';

/** Pi-native provider authentication and model catalog settings. */
export const ProvidersPage: React.FC = () => {
  const selectedProviderId = usePiProviderSelectionStore((state) => state.selectedProviderId);
  const setSelectedProviderId = usePiProviderSelectionStore((state) => state.setSelectedProviderId);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const isHiddenModel = useUIStore((state) => state.isHiddenModel);
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
  const [refreshingCatalog, setRefreshingCatalog] = React.useState(false);
  const [thinkingBusyKeys, setThinkingBusyKeys] = React.useState<Set<string>>(new Set());
  const [modelFilter, setModelFilter] = React.useState('');
  const [visibleCap, setVisibleCap] = React.useState(80);

  const refresh = React.useCallback(async () => {
    const { providers: result } = await piClient.listProviders(providerScope());
    setProviders(result);
    setFailed(false);
    if (!selectedProviderId && result[0]) setSelectedProviderId(result[0].id);
    void useConfigStore.getState().loadProviders({ source: 'providersPage:refresh' });
  }, [selectedProviderId, setSelectedProviderId]);

  const refreshCatalog = React.useCallback(async () => {
    if (refreshingCatalog) return;
    setRefreshingCatalog(true);
    try {
      const { providers: result } = await piClient.refreshProviders(providerScope());
      setProviders(result);
      setFailed(false);
      if (!selectedProviderId && result[0]) setSelectedProviderId(result[0].id);
      const configStore = useConfigStore.getState();
      configStore.invalidateProviderCache();
      void configStore.loadProviders({ source: 'providersPage:refreshCatalog' });
    } catch {
      setFailed(true);
    } finally {
      setRefreshingCatalog(false);
    }
  }, [refreshingCatalog, selectedProviderId, setSelectedProviderId]);

  React.useEffect(() => {
    let active = true;
    void refresh().catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [refresh]);

  // Warm the sidecar thinking defaults into the shared config store so the
  // provider model rows render the authoritative per-model default without
  // requiring a prior visit to Session Defaults. Failure is not empty — keep
  // whatever the store already has.
  React.useEffect(() => {
    let active = true;
    const scope = providerScope();
    void piClient.getSettings(scope).then((snapshot) => {
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
    }).catch(() => {
      // Preserve existing map on fetch failure — empty is not authoritative.
    });
    return () => { active = false; };
  }, [setSettingsDefaultThinking, setSettingsDefaultThinkingByModel]);

  React.useEffect(() => {
    if (!login || login.state !== 'pending') return;
    let active = true;
    const timer = window.setInterval(() => {
      void piClient.getProviderLogin(login.providerId, login.id, providerScope()).then((result) => {
        if (!active) return;
        setLogin(result.login);
        if (result.login.state === 'complete') void refresh().catch(() => setFailed(true));
      }).catch(() => {
        if (active) setLogin((current) => current ? { ...current, state: 'failed', error: { code: 'PROVIDER_AUTH_REQUIRED' } } : current);
      });
    }, 1_000);
    return () => { active = false; window.clearInterval(timer); };
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
      if (!selectedProviderId && detail[0]) setSelectedProviderId(detail[0].id);
    };
    window.addEventListener('pichamber:providers-refreshed', handler as EventListener);
    return () => window.removeEventListener('pichamber:providers-refreshed', handler as EventListener);
  }, [selectedProviderId, setSelectedProviderId]);

  const provider = providers?.find((item) => item.id === selectedProviderId) ?? null;
  const providerId = provider?.id;
  React.useEffect(() => {
    if (!providerId) {
      setProviderConfig(null);
      return;
    }
    let active = true;
    void piClient.getProviderConfig(providerId, providerScope()).then((result) => {
      if (active) setProviderConfig(result.config);
    }).catch(() => {
      // Built-in providers have no models.json row; treat that as "not custom".
      if (active) setProviderConfig(null);
    });
    return () => { active = false; };
  }, [providerId]);

  const persistThinkingForModel = React.useCallback(async (pId: string, mId: string, level: PiThinkingLevel | null) => {
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
  }, [setSettingsDefaultThinking, setSettingsDefaultThinkingByModel]);

  const handleThinkingChange = React.useCallback((pId: string, mId: string, level: PiThinkingLevel | null) => {
    void persistThinkingForModel(pId, mId, level);
  }, [persistThinkingForModel]);

  const handleToggleHidden = React.useCallback((pId: string, mId: string) => {
    toggleHiddenModel(pId, mId);
  }, [toggleHiddenModel]);

  React.useEffect(() => {
    setModelFilter('');
    setVisibleCap(80);
  }, [providerId]);

  React.useEffect(() => {
    setVisibleCap(80);
  }, [modelFilter]);

  const filteredModels = React.useMemo(() => {
    if (!provider) return [];
    const query = modelFilter.trim().toLowerCase();
    if (!query) return provider.models;
    return provider.models.filter((model) => {
      const label = (model.label || model.id).toLowerCase();
      return label.includes(query) || model.id.toLowerCase().includes(query);
    });
  }, [provider, modelFilter]);

  const displayModels = React.useMemo(() => filteredModels.slice(0, visibleCap), [filteredModels, visibleCap]);
  const hasMore = filteredModels.length > displayModels.length;

  const saveCustomProvider = async (plan: CustomProviderPersistPlan) => {
    setBusy(true);
    try {
      await piClient.setProviderModels({
        providerId: plan.providerID,
        label: plan.name,
        baseUrl: plan.config.options.baseURL,
        api: 'openai-completions',
        models: Object.entries(plan.config.models).map(([id, model]) => ({ id, providerId: plan.providerID, label: model.name })),
        ...(plan.config.options.headers ? { headers: plan.config.options.headers } : {}),
        ...(plan.config.env?.[0] ? { apiKeyReference: `{env:${plan.config.env[0]}}` } : {}),
      }, providerScope());
      if (plan.apiKey) setLogin((await piClient.loginProvider({ providerId: plan.providerID, type: 'api_key', apiKey: plan.apiKey }, providerScope())).login);
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
      const result = await piClient.loginProvider({ providerId: provider.id, type, ...(type === 'api_key' ? { apiKey: apiKey.trim() } : {}) }, providerScope());
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
      setLogin((current) => current ? { ...current, state: 'failed', error: { code: 'PROVIDER_AUTH_REQUIRED' } } : current);
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

  if (failed && !providers) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Unavailable</div>;
  }
  const isCreatingCustom = selectedProviderId === PI_CUSTOM_PROVIDER_SELECTION;
  if (customEditing || isCreatingCustom) {
    const editableConfig = providerConfig?.providerId === provider?.id ? providerConfig : null;
    const initialValues = editableConfig
      ? providerToCustomFormState({ id: editableConfig.providerId, name: editableConfig.label, options: { baseURL: editableConfig.baseUrl }, models: editableConfig.models })
      : undefined;
    return (
      <SettingsPageLayout title={editableConfig ? 'Edit custom provider' : 'Custom provider'}>
        <CustomProviderForm
          existingProviderIDs={new Set(providers?.map((item) => item.id) ?? [])}
          mode={editableConfig ? 'edit' : 'create'}
          initialValues={initialValues}
          allowExistingAuth={provider?.authenticated === true}
          busy={busy}
          onSubmit={(plan) => void saveCustomProvider(plan)}
          onCancel={() => {
            setCustomEditing(false);
            setSelectedProviderId(provider?.id ?? providers?.[0]?.id ?? null);
          }}
        />
      </SettingsPageLayout>
    );
  }

  if (!provider) {
    if (providers === null) {
      return <div className="flex h-full items-center justify-center text-muted-foreground">Loading...</div>;
    }
    return <div className="flex h-full items-center justify-center text-muted-foreground">No providers</div>;
  }

  const activeLogin = login?.providerId === provider.id ? login : null;
  const isConnected = provider.authenticated || activeLogin?.state === 'complete';
  return (
    <SettingsPageLayout
      title={provider.label}
      titleLeading={<ProviderLogo providerId={provider.id} className="size-5 shrink-0" />}
      description={<span className="font-mono typography-settings-description text-muted-foreground">{provider.id}</span>}
    >
      {failed ? <p className="typography-meta text-[var(--status-error)]">Unavailable</p> : null}
      <SettingsSection
        title="Authentication"
        divider={false}
        settingsItem="providers.auth"
        headerAction={isConnected ? (
          <Button variant="ghost" size="xs" onClick={() => void logout()} disabled={busy}>
            {busy ? 'Disconnecting...' : 'Disconnect'}
          </Button>
        ) : null}
      >
        {isConnected ? (
          <div className="flex items-center gap-1.5 py-1.5 typography-ui-label">
            <Icon name="check" className="size-4 text-[var(--status-success)]" />
            Connected
          </div>
        ) : (
          <div className="space-y-4 py-1.5">
            <SettingsFieldRow label="API Key">
              <div className="flex w-full max-w-[24rem] gap-2">
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-..."
                  autoComplete="off"
                />
                <Button size="sm" onClick={() => void startLogin('api_key')} disabled={busy || apiKey.trim().length === 0}>
                  {busy ? 'Saving...' : 'Save Key'}
                </Button>
              </div>
            </SettingsFieldRow>
            <Button variant="outline" size="sm" onClick={() => void startLogin('oauth')} disabled={busy}>
              Reconnect
            </Button>
          </div>
        )}
        {activeLogin?.state === 'pending' ? (
          <ProviderLoginFlow login={activeLogin} promptValue={promptValue} onPromptValueChange={setPromptValue} onSubmit={() => void submitPrompt()} busy={busy} />
        ) : null}
        {activeLogin?.state === 'failed' ? <p className="typography-meta text-[var(--status-error)]">Authorization was declined or did not complete.</p> : null}
      </SettingsSection>

      <SettingsSection
        title="Available Models"
        settingsItem="providers.models"
        info="Hidden models stay out of the composer and session default pickers. Thinking defaults apply to new sessions and composer model changes."
        headerAction={(
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => void refreshCatalog()} disabled={refreshingCatalog || busy}>
              {refreshingCatalog ? 'Refreshing...' : 'Refresh catalog'}
            </Button>
            {isConnected ? (
              <>
                <Button variant="ghost" size="xs" onClick={() => showAllModels(provider.id)}>
                  Show all
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => hideAllModels(provider.id, provider.models.map((model) => model.id))}
                >
                  Hide all
                </Button>
              </>
            ) : null}
            {providerConfig ? (
              <Button variant="ghost" size="xs" onClick={() => setCustomEditing(true)}>
                Update provider
              </Button>
            ) : null}
          </div>
        )}
      >
        {provider.models.length > 8 ? (
          <div className="pb-3">
            <Input
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              placeholder="Filter models"
              aria-label="Filter models"
              className="max-w-[24rem]"
            />
          </div>
        ) : null}
        <div className="divide-y divide-[var(--surface-subtle)]">
          {filteredModels.length === 0 ? (
            <p className="py-3 typography-meta text-muted-foreground">No models match.</p>
          ) : (
            displayModels.map((model) => {
              const hidden = isHiddenModel(provider.id, model.id);
              const key = thinkingModelKey({ providerId: provider.id, modelId: model.id }) ?? `${provider.id}/${model.id}`;
              const raw = settingsDefaultThinkingByModel[key];
              const storedLevel = isPiThinkingLevel(raw) ? raw : undefined;
              const isBusy = thinkingBusyKeys.has(key);
              return (
                <ProviderModelRow
                  key={model.id}
                  providerId={provider.id}
                  model={model}
                  storedLevel={storedLevel}
                  isBusy={isBusy}
                  isHidden={hidden}
                  isConnected={isConnected}
                  onThinkingChange={handleThinkingChange}
                  onToggleHidden={handleToggleHidden}
                />
              );
            })
          )}
          {hasMore ? (
            <div className="flex justify-center py-2">
              <Button variant="ghost" size="xs" onClick={() => setVisibleCap((c) => c + 80)}>
                Show {Math.min(80, filteredModels.length - displayModels.length)} more ({displayModels.length} of {filteredModels.length})
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};

const ProviderLoginFlow: React.FC<{
  login: PiProviderLoginState;
  promptValue: string;
  onPromptValueChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}> = ({ login, promptValue, onPromptValueChange, onSubmit, busy }) => {
  return (
    <div className="space-y-3 border-t border-[var(--surface-subtle)] pt-3">
      {login.authUrl ? (
        <a className="typography-meta text-[var(--primary-base)] underline" href={login.authUrl.url} target="_blank" rel="noreferrer">
          {login.authUrl.instructions || 'Open'}
        </a>
      ) : null}
      {login.deviceCode ? (
        <div className="typography-meta text-muted-foreground">
          <span className="mr-2">Device code</span>
          <code className="text-foreground">{login.deviceCode.userCode}</code>
          <a className="ml-2 text-[var(--primary-base)] underline" href={login.deviceCode.verificationUri} target="_blank" rel="noreferrer">Open</a>
        </div>
      ) : null}
      {login.prompt ? (
        <SettingsFieldRow label={login.prompt.message || 'Copy the authorization code from your browser and paste it here.'}>
          {login.prompt.type === 'select' && login.prompt.options ? (
            <Select value={promptValue} onValueChange={onPromptValueChange}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}><SelectValue /></SelectTrigger>
              <SelectContent>{login.prompt.options.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <Input type={login.prompt.type === 'secret' ? 'password' : 'text'} value={promptValue} onChange={(event) => onPromptValueChange(event.target.value)} placeholder={login.prompt.placeholder} autoComplete="off" />
          )}
          <Button size="sm" onClick={onSubmit} disabled={busy || promptValue.length === 0}>Continue</Button>
        </SettingsFieldRow>
      ) : <p className="typography-meta text-muted-foreground">Waiting for authorization…</p>}
    </div>
  );
};
