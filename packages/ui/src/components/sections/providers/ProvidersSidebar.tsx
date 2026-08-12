import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { piClient } from '@/lib/pi/client';
import { PI_CUSTOM_PROVIDER_SELECTION, usePiProviderSelectionStore } from '@/lib/pi/provider-selection';
import type { PiProvider } from '@/lib/pi/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';

interface ProvidersSidebarProps {
  onItemSelect?: () => void;
}

/** Pi provider catalog sidebar. It owns no credentials and never reads OpenCode config. */
export const ProvidersSidebar: React.FC<ProvidersSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const selectedProviderId = usePiProviderSelectionStore((state) => state.selectedProviderId);
  const setSelectedProviderId = usePiProviderSelectionStore((state) => state.setSelectedProviderId);
  const [providers, setProviders] = React.useState<readonly PiProvider[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    const runtimeKey = getRuntimeKey();
    void piClient.listProviders({ runtimeKey }).then(({ providers: result }) => {
      if (!active) return;
      setProviders(result);
      setFailed(false);
      if (!selectedProviderId && result[0]) setSelectedProviderId(result[0].id);
    }).catch(() => {
      if (!active) return;
      setFailed(true);
      setProviders(null);
    });
    return () => { active = false; };
  }, [selectedProviderId, setSelectedProviderId]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-3 pb-3 pt-4">
        <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{t('settings.providers.sidebar.title')}</h2>
        <span className="typography-meta text-muted-foreground">
          {providers ? t('settings.providers.sidebar.total', { count: providers.length }) : t('common.loading')}
        </span>
      </div>
      <ScrollableOverlay outerClassName="min-h-0 flex-1" className="space-y-1 overflow-x-hidden px-3 py-2">
        <button
          type="button"
          onClick={() => { setSelectedProviderId(PI_CUSTOM_PROVIDER_SELECTION); onItemSelect?.(); }}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
            selectedProviderId === PI_CUSTOM_PROVIDER_SELECTION ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
          )}
        >
          <Icon name="add" className="size-4 shrink-0" />
          <span className="typography-ui-label font-normal">{t('settings.providers.page.custom.optionLabel')}</span>
        </button>
        {failed ? <p className="px-2 py-3 typography-meta text-[var(--status-error)]">{t('common.unavailable')}</p> : null}
        {providers?.map((provider) => {
          const selected = selectedProviderId === provider.id;
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => { setSelectedProviderId(provider.id); onItemSelect?.(); }}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
              )}
            >
              <ProviderLogo providerId={provider.id} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate typography-ui-label font-normal">{provider.label}</span>
              {provider.authenticated ? <Icon name="check" className="size-4 shrink-0 text-[var(--status-success)]" /> : null}
              <span className="shrink-0 typography-micro text-muted-foreground">{provider.models.length}</span>
            </button>
          );
        })}
      </ScrollableOverlay>
    </div>
  );
};
