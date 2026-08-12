import React from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { BehaviorPage } from '@/components/sections/behavior/BehaviorPage';
import { MagicPromptsPage } from '@/components/sections/magic-prompts/MagicPromptsPage';
import { MagicPromptsSidebar } from '@/components/sections/magic-prompts/MagicPromptsSidebar';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { ProvidersSidebar } from '@/components/sections/providers/ProvidersSidebar';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { SkillsSidebar } from '@/components/sections/skills/SkillsSidebar';
import { SnippetsPage } from '@/components/sections/snippets/SnippetsPage';
import { SnippetsSidebar } from '@/components/sections/snippets/SnippetsSidebar';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';

import { type PiResourceSettingsPage } from './pi-resource-settings-page';
import type { I18nKey } from '@/lib/i18n';

const SETTINGS_SPLIT_SIDEBAR_WIDTH = 280;

const PAGES: readonly { id: PiResourceSettingsPage; titleKey: I18nKey }[] = [
  { id: 'providers', titleKey: 'settings.page.providers.title' },
  { id: 'skills.installed', titleKey: 'settings.page.skills.title' },
  { id: 'snippets', titleKey: 'settings.page.snippets.title' },
  { id: 'behavior', titleKey: 'settings.page.behavior.title' },
  { id: 'magic-prompts', titleKey: 'settings.page.magicPrompts.title' },
];

/** Hosts the Workstream 5 resource/trust Settings pages inside the mounted Pi app. */
export const PiResourceSettings: React.FC<{
  page: PiResourceSettingsPage;
  onPageChange: (page: PiResourceSettingsPage) => void;
  onClose: () => void;
}> = ({ page, onPageChange, onClose }) => {
  const { t } = useI18n();

  React.useEffect(() => {
    if (page === 'skills.installed') void useSkillsStore.getState().loadSkills();
    if (page === 'snippets') void useSnippetsStore.getState().loadSnippets();
  }, [page]);

  const sidebar = page === 'providers' ? <ProvidersSidebar />
    : page === 'skills.installed' ? <SkillsSidebar />
    : page === 'snippets' ? <SnippetsSidebar />
    : page === 'magic-prompts' ? <MagicPromptsSidebar />
    : null;

  const content = page === 'providers' ? <ProvidersPage />
    : page === 'skills.installed' ? <SkillsPage />
    : page === 'snippets' ? <SnippetsPage />
    : page === 'behavior' ? <BehaviorPage />
    : <MagicPromptsPage />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface-background)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--interactive-border)] p-2">
        <Button size="sm" variant="ghost" onClick={onClose}>{t('settings.view.actions.back')}</Button>
        <nav className="flex min-w-0 flex-1 flex-wrap gap-1" aria-label={t('settings.view.home.title')}>
          {PAGES.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant="chip"
              aria-pressed={page === item.id}
              onClick={() => onPageChange(item.id)}
            >
              {t(item.titleKey)}
            </Button>
          ))}
        </nav>
      </header>
      <div className="flex min-h-0 flex-1">
        {sidebar ? (
          <aside className="shrink-0 border-r border-[var(--interactive-border)]" style={{ width: SETTINGS_SPLIT_SIDEBAR_WIDTH }}>
            {sidebar}
          </aside>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">{content}</div>
      </div>
    </div>
  );
};
