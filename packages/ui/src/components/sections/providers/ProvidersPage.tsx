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
import type { PiProvider } from '@/lib/pi/types';
import { cn } from '@/lib/utils';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

const providerScope = () => ({ runtimeKey: getRuntimeKey() });

/** Pi-native provider authentication and model catalog settings. */
export const ProvidersPage: React.FC = () => {
  
  const selectedProviderId = usePiProviderSelectionStore((state) => state.selectedProviderId);
  const setSelectedProviderId = usePiProviderSelectionStore((state) => state.setSelectedProviderId);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const isHiddenModel = useUIStore((state) => state.isHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);
  const [providers, setProviders] = React.useState<readonly PiProvider[] | null>(null);
  const [apiKey, setApiKey] = React.useState('');
  const [promptValue, setPromptValue] = React.useState('');
  const [login, setLogin] = React.useState<PiProviderLoginState | null>(null);
  const [customEditing, setCustomEditing] = React.useState(false);
  const [providerConfig, setProviderConfig] = React.useState<Awaited<ReturnType<typeof piClient.getProviderConfig>>['config']>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = React.useState(false);

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
    return <div className="flex h-full items-center justify-center text-muted-foreground">{"Unavailable"}</div>;
  }
  const isCreatingCustom = selectedProviderId === PI_CUSTOM_PROVIDER_SELECTION;
  if (customEditing || isCreatingCustom) {
    const editableConfig = providerConfig?.providerId === provider?.id ? providerConfig : null;
    const initialValues = editableConfig
      ? providerToCustomFormState({ id: editableConfig.providerId, name: editableConfig.label, options: { baseURL: editableConfig.baseUrl }, models: editableConfig.models })
      : undefined;
    return (
      <SettingsPageLayout title={editableConfig ? "Edit custom provider" : "Custom provider"} showSaveStatus={false}>
        <CustomProviderForm
          existingProviderIDs={new Set(providers?.map((item) => item.id) ?? [])}
          mode={editableConfig ? "edit" : "create"}
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
      return <div className="flex h-full items-center justify-center text-muted-foreground">{"Loading..."}</div>;
    }
    return <div className="flex h-full items-center justify-center text-muted-foreground">{"No providers"}</div>;
  }

  const activeLogin = login?.providerId === provider.id ? login : null;
  const isConnected = provider.authenticated || activeLogin?.state === 'complete';
  return (
    <SettingsPageLayout
      title={provider.label}
      titleLeading={<ProviderLogo providerId={provider.id} className="size-5 shrink-0" />}
      description={<span className="font-mono typography-settings-description text-muted-foreground">{provider.id}</span>}
      showSaveStatus={false}
    >
      {failed ? <p className="typography-meta text-[var(--status-error)]">{"Unavailable"}</p> : null}
      <SettingsSection
        title={"Authentication"}
        divider={false}
        settingsItem="providers.auth"
        headerAction={isConnected ? (
          <Button variant="ghost" size="xs" onClick={() => void logout()} disabled={busy}>
            {busy ? "Disconnecting..." : "Disconnect"}
          </Button>
        ) : null}
      >
        {isConnected ? (
          <div className="flex items-center gap-1.5 py-1.5 typography-ui-label">
            <Icon name="check" className="size-4 text-[var(--status-success)]" />
            {"Connected"}
          </div>
        ) : (
          <div className="space-y-4 py-1.5">
            <SettingsFieldRow label={"API Key"}>
              <div className="flex w-full max-w-[24rem] gap-2">
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={"sk-..."}
                  autoComplete="off"
                />
                <Button size="sm" onClick={() => void startLogin('api_key')} disabled={busy || apiKey.trim().length === 0}>
                  {busy ? "Saving..." : "Save Key"}
                </Button>
              </div>
            </SettingsFieldRow>
            <Button variant="outline" size="sm" onClick={() => void startLogin('oauth')} disabled={busy}>
              {"Reconnect"}
            </Button>
          </div>
        )}
        {activeLogin?.state === 'pending' ? (
          <ProviderLoginFlow login={activeLogin} promptValue={promptValue} onPromptValueChange={setPromptValue} onSubmit={() => void submitPrompt()} busy={busy} />
        ) : null}
        {activeLogin?.state === 'failed' ? <p className="typography-meta text-[var(--status-error)]">{"Authorization was declined or did not complete."}</p> : null}
      </SettingsSection>

      <SettingsSection
        title={"Available Models"}
        settingsItem="providers.models"
        info={isConnected ? "Hidden models stay out of the composer and session default pickers." : undefined}
        headerAction={(
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => void refreshCatalog()} disabled={refreshingCatalog || busy}>
              {refreshingCatalog ? "Refreshing..." : "Refresh catalog"}
            </Button>
            {isConnected ? (
              <>
                <Button variant="ghost" size="xs" onClick={() => showAllModels(provider.id)}>
                  {"Show all"}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => hideAllModels(provider.id, provider.models.map((model) => model.id))}
                >
                  {"Hide all"}
                </Button>
              </>
            ) : null}
            {providerConfig ? (
              <Button variant="ghost" size="xs" onClick={() => setCustomEditing(true)}>
                {"Update provider"}
              </Button>
            ) : null}
          </div>
        )}
      >
        <div className="divide-y divide-[var(--surface-subtle)]">
          {provider.models.map((model) => {
            const hidden = isHiddenModel(provider.id, model.id);
            return (
              <div
                key={model.id}
                className={cn('flex min-w-0 items-center gap-2 py-2', hidden && 'opacity-60')}
              >
                <span className="min-w-0 flex-1 truncate typography-ui-label">{model.label || model.id}</span>
                {model.supportsThinking ? <Icon name="brain-ai-3" className="size-4 shrink-0 text-muted-foreground" aria-label={"Reasoning"} /> : null}
                {typeof model.contextWindow === 'number' ? <span className="shrink-0 typography-micro text-muted-foreground">{model.contextWindow}</span> : null}
                {isConnected ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => toggleHiddenModel(provider.id, model.id)}
                    aria-label={hidden ? "Show model in pickers" : "Hide model from pickers"}
                    title={hidden ? "Show model in pickers" : "Hide model from pickers"}
                  >
                    <Icon name={hidden ? 'eye' : 'eye-off'} className="size-4" />
                  </Button>
                ) : null}
              </div>
            );
          })}
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
          {login.authUrl.instructions || "Open"}
        </a>
      ) : null}
      {login.deviceCode ? (
        <div className="typography-meta text-muted-foreground">
          <span className="mr-2">{"Device code"}</span>
          <code className="text-foreground">{login.deviceCode.userCode}</code>
          <a className="ml-2 text-[var(--primary-base)] underline" href={login.deviceCode.verificationUri} target="_blank" rel="noreferrer">{"Open"}</a>
        </div>
      ) : null}
      {login.prompt ? (
        <SettingsFieldRow label={login.prompt.message || "Copy the authorization code from your browser and paste it here."}>
          {login.prompt.type === 'select' && login.prompt.options ? (
            <Select value={promptValue} onValueChange={onPromptValueChange}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}><SelectValue /></SelectTrigger>
              <SelectContent>{login.prompt.options.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <Input type={login.prompt.type === 'secret' ? 'password' : 'text'} value={promptValue} onChange={(event) => onPromptValueChange(event.target.value)} placeholder={login.prompt.placeholder} autoComplete="off" />
          )}
          <Button size="sm" onClick={onSubmit} disabled={busy || promptValue.length === 0}>{"Continue"}</Button>
        </SettingsFieldRow>
      ) : <p className="typography-meta text-muted-foreground">{"Waiting for authorization…"}</p>}
    </div>
  );
};
