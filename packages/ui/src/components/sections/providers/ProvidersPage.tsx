import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { CustomProviderForm } from '@/components/sections/providers/CustomProviderForm';
import { ProviderCard, ProviderCardSkeleton } from '@/components/sections/providers/ProviderCard';
import {
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PI_CUSTOM_PROVIDER_SELECTION } from '@/lib/pi/provider-selection';
import { providerToCustomFormState } from './custom-provider-form';
import { cn } from '@/lib/utils';
import { isPiThinkingLevel, thinkingModelKey } from '@/lib/pi/thinking';
import { useDeviceInfo } from '@/lib/device';
import { isHiddenModelRef } from '@/lib/pi/hidden-models';
import { ProviderModelRow } from './ProviderModelRow';
import { ProviderLoginFlow } from './ProviderLoginFlow';
import { useProvidersPageState } from './useProvidersPageState';

/** Pi-native provider authentication and model catalog settings. */
export const ProvidersPage: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const {
    selectedProviderId,
    setSelectedProviderId,
    hiddenModels,
    hideAllModels,
    showAllModels,
    settingsDefaultThinkingByModel,
    providers,
    apiKey,
    setApiKey,
    promptValue,
    setPromptValue,
    login,
    customEditing,
    setCustomEditing,
    providerConfig,
    busy,
    failed,
    refreshing,
    refreshingCatalog,
    catalogRefreshFeedback,
    thinkingBusyKeys,
    providerQuery,
    setProviderQuery,
    setVisibleCap,
    refreshProviders,
    refreshCatalog,
    provider,
    filteredProviders,
    displayModels,
    hasMore,
    saveCustomProvider,
    startLogin,
    submitPrompt,
    logout,
    handleThinkingChange,
    handleToggleHidden,
  } = useProvidersPageState();

  if (failed && !providers) {
    return (
      <SettingsPageLayout title={isMobile ? undefined : 'Providers'} description={isMobile ? undefined : 'Manage model providers and authentication.'}>
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <p className="typography-meta text-[var(--status-error)]">Providers are unavailable.</p>
          <Button variant="outline" size="sm" onClick={() => void refreshProviders()} disabled={refreshing}>
            <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
            {refreshing ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </SettingsPageLayout>
    );
  }

  const isCreatingCustom = selectedProviderId === PI_CUSTOM_PROVIDER_SELECTION;
  if (customEditing || isCreatingCustom) {
    const editableConfig = providerConfig?.providerId === provider?.id ? providerConfig : null;
    const initialValues = editableConfig
      ? providerToCustomFormState({
          id: editableConfig.providerId,
          name: editableConfig.label,
          options: { baseURL: editableConfig.baseUrl },
          models: editableConfig.models,
        })
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
            setSelectedProviderId(provider?.id ?? null);
          }}
        />
      </SettingsPageLayout>
    );
  }

  // Detail view for selected provider
  if (provider) {
    const activeLogin = login?.providerId === provider.id ? login : null;
    const isConnected = provider.authenticated || activeLogin?.state === 'complete';
    return (
      <SettingsPageLayout
        title={
          <span className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setSelectedProviderId(null)}
              aria-label="Back to providers"
              className="-ml-1 h-7 w-7 p-0"
            >
              <Icon name="arrow-left-s" className="size-4" />
            </Button>
            <ProviderLogo providerId={provider.id} className="size-5 shrink-0" />
            <span className="truncate">{provider.label}</span>
          </span>
        }
        description={<span className="font-mono typography-settings-description text-muted-foreground">{provider.id}</span>}
      >
        {failed ? <p className="typography-meta text-[var(--status-error)]">Unavailable</p> : null}
        <SettingsSection
          title="Authentication"
          divider={false}
          settingsItem="providers.auth"
          headerAction={
            isConnected ? (
              <Button variant="ghost" size="xs" onClick={() => void logout()} disabled={busy}>
                {busy ? 'Disconnecting...' : 'Disconnect'}
              </Button>
            ) : null
          }
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
            <ProviderLoginFlow
              login={activeLogin}
              promptValue={promptValue}
              onPromptValueChange={setPromptValue}
              onSubmit={() => void submitPrompt()}
              busy={busy}
            />
          ) : null}
          {activeLogin?.state === 'failed' ? (
            <p className="typography-meta text-[var(--status-error)]">Authorization was declined or did not complete.</p>
          ) : null}
        </SettingsSection>

        <SettingsSection
          title="Available Models"
          settingsItem="providers.models"
          info="Hidden models stay out of the composer and session default pickers. Thinking defaults apply to new sessions and composer model changes."
          headerAction={
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size={isMobile ? 'sm' : 'icon'}
                onClick={() => void refreshCatalog()}
                disabled={refreshingCatalog || busy}
                aria-label="Refresh model catalog"
                title="Refresh model catalog"
              >
                <Icon name="refresh" className={cn('size-4', refreshingCatalog && 'animate-spin')} />
              </Button>
              {isConnected ? (
                <>
                  <Button variant="ghost" size="xs" onClick={() => showAllModels(provider.id)}>
                    Show all
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => hideAllModels(provider.id, provider.models.map((model) => model.id))}>
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
          }
        >
          <div aria-live="polite" className="sr-only">
            {refreshingCatalog
              ? 'Refreshing model catalog'
              : catalogRefreshFeedback === 'success'
                ? 'Model catalog refreshed'
                : catalogRefreshFeedback === 'error'
                  ? 'Could not refresh model catalog'
                  : ''}
          </div>
          <div className="divide-y divide-[var(--surface-subtle)]">
            {provider.models.length === 0 ? (
              <p className="py-3 typography-meta text-muted-foreground">No models available.</p>
            ) : (
              displayModels.map((model) => {
                const hidden = isHiddenModelRef(hiddenModels, provider.id, model.id);
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
                  Show {Math.min(80, provider.models.length - displayModels.length)} more ({displayModels.length} of{' '}
                  {provider.models.length})
                </Button>
              </div>
            ) : null}
          </div>
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  // Grid browse view (no provider selected)
  if (providers === null) {
    return (
      <SettingsPageLayout
        title={isMobile ? undefined : 'Providers'}
        description={isMobile ? undefined : 'Manage model providers and authentication. Authenticated providers appear first.'}
        headerEnd={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size={isMobile ? 'sm' : 'icon'}
              onClick={() => void refreshProviders()}
              disabled={refreshing}
              aria-label="Refresh providers"
              title="Refresh providers"
            >
              <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
            </Button>
          </div>
        }
      >
        <SettingsSection title="Providers" divider={false} settingsItem="providers.browse">
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
            <ProviderCardSkeleton count={6} />
          </div>
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  if (filteredProviders.length === 0 && providerQuery.trim() === '' && providers.length === 0) {
    return (
      <SettingsPageLayout
        title={isMobile ? undefined : 'Providers'}
        description={isMobile ? undefined : 'Manage model providers and authentication. Authenticated providers appear first.'}
        headerEnd={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={providerQuery}
                onChange={(event) => setProviderQuery(event.target.value)}
                placeholder="Search providers"
                aria-label="Search providers"
                className="h-9 w-[18rem] max-w-[24rem] pl-8"
              />
            </div>
            <Button
              variant="ghost"
              size={isMobile ? 'sm' : 'icon'}
              onClick={() => void refreshProviders()}
              disabled={refreshing}
              aria-label="Refresh providers"
              title="Refresh providers"
            >
              <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelectedProviderId(PI_CUSTOM_PROVIDER_SELECTION)}>
              <Icon name="add" className="size-4" />
              Add custom provider
            </Button>
          </div>
        }
      >
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <Icon name="cloud-off" className="size-8 text-muted-foreground/60" aria-hidden />
          <p className="typography-meta text-muted-foreground">No providers</p>
          <Button variant="outline" size="sm" onClick={() => setSelectedProviderId(PI_CUSTOM_PROVIDER_SELECTION)}>
            Add custom provider
          </Button>
        </div>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout
      title={isMobile ? undefined : 'Providers'}
      description={isMobile ? undefined : 'Manage model providers and authentication. Authenticated providers appear first.'}
      headerEnd={
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Icon
              name="search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.target.value)}
              placeholder="Search providers"
              aria-label="Search providers"
              className="h-9 w-[18rem] max-w-[24rem] pl-8"
            />
            {providerQuery ? (
              <button
                type="button"
                onClick={() => setProviderQuery('')}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="close" className="size-4" />
              </button>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size={isMobile ? 'sm' : 'icon'}
            onClick={() => void refreshProviders()}
            disabled={refreshing}
            aria-label="Refresh providers"
            title="Refresh providers"
          >
            <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSelectedProviderId(PI_CUSTOM_PROVIDER_SELECTION)}>
            <Icon name="add" className="size-4" />
            Add custom provider
          </Button>
        </div>
      }
    >
      {failed ? <p className="typography-meta text-[var(--status-error)]">Refresh failed — showing cached providers.</p> : null}
      <SettingsSection title="Providers" divider={false} settingsItem="providers.browse">
        {filteredProviders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="typography-meta text-muted-foreground">No providers match “{providerQuery}”.</p>
            <Button variant="ghost" size="xs" onClick={() => setProviderQuery('')}>
              Clear search
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
            {filteredProviders.map((p) => (
              <ProviderCard key={p.id} provider={p} onSelect={setSelectedProviderId} />
            ))}
            <button
              type="button"
              onClick={() => setSelectedProviderId(PI_CUSTOM_PROVIDER_SELECTION)}
              aria-label="Add custom provider"
              className={cn(
                'group flex min-h-[118px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4',
                'border-border/60 bg-transparent text-muted-foreground',
                'hover:border-border hover:bg-interactive-hover hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                'transition-colors duration-150',
              )}
            >
              <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted">
                <Icon name="add" className="size-5" />
              </span>
              <span className="typography-ui-label font-medium">Add custom provider</span>
              <span className="typography-micro text-muted-foreground">OpenAI-compatible</span>
            </button>
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
