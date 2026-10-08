import React from 'react';
import { BehaviorPage } from '@/components/sections/behavior/BehaviorPage';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { ProjectsPage } from '@/components/sections/projects/ProjectsPage';
import { RemoteAccessPage } from '@/components/sections/remote-access/RemoteAccessPage';
import { ServersPage } from '@/components/sections/servers/ServersPage';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { SnippetsPage } from '@/components/sections/snippets/SnippetsPage';
import { PromptTemplatesPage } from '@/components/sections/prompt-templates/PromptTemplatesPage';
import { GitSettings } from '@/components/sections/pichamber/GitSettings';
import type { PiChamberSection } from '@/components/sections/pichamber/types';
import { PiChamberPage } from '@/components/sections/pichamber/PiChamberPage';
import { AboutSettings } from '@/components/sections/pichamber/AboutSettings';
import { DictationSettings } from '@/components/sections/pichamber/DictationSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_SECTION_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import {
  getSettingsPageMeta,
  type SettingsPageSlug,
  type SettingsRuntimeContext,
} from '@/lib/settings/metadata';
import { isPageAvailable } from './settingsViewHelpers';

export function SettingsUnavailableView(): React.ReactNode {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className={SETTINGS_SECTION_TITLE_CLASS}>{"Not available"}</div>
        <p className="typography-ui text-muted-foreground mt-1">
          {"This settings page is not available in this runtime."}
        </p>
      </div>
    </div>
  );
}

export type SettingsPageContentProps = {
  slug: SettingsPageSlug;
  isMobile: boolean;
  runtimeCtx: SettingsRuntimeContext;
  openChamberSectionBySlug: Record<string, PiChamberSection>;
  /** Capacitor shell: deleting the active/last server leaves to connect. */
  onActiveConnectionDeleted?: () => void;
};

export function SettingsPageContent({
  slug,
  isMobile,
  runtimeCtx,
  openChamberSectionBySlug,
  onActiveConnectionDeleted,
}: SettingsPageContentProps): React.ReactNode {
  const meta = getSettingsPageMeta(slug);
  if (meta && !isPageAvailable(meta, runtimeCtx)) {
    return <SettingsUnavailableView />;
  }

  switch (slug) {
    case 'projects':
      return <ProjectsPage />;
    case 'remote-access':
      return <RemoteAccessPage />;
    case 'servers':
      return <ServersPage onActiveConnectionDeleted={onActiveConnectionDeleted} />;
    case 'remote-instances':
      // Legacy deep links resolve to remote-access via resolveSettingsSlug,
      // but a persisted raw slug can still arrive here. Render the new page
      // so old links never land on a removed page.
      return <RemoteAccessPage />;
    case 'behavior':
      return <BehaviorPage />;
    case 'skills.installed':
      return <SkillsPage />;
    case 'providers':
      return <ProvidersPage />;
    case 'about':
      return (
        <SettingsPageLayout title={isMobile ? undefined : "About"}>
          <AboutSettings />
        </SettingsPageLayout>
      );
    case 'snippets':
      return <SnippetsPage />;
    case 'prompt-templates':
      return <PromptTemplatesPage />;
    case 'dictation':
      return <DictationSettings />;
    case 'git':
      return (
        <SettingsPageLayout title={isMobile ? undefined : "Git"}>
          <GitSettings />
        </SettingsPageLayout>
      );
    case 'general':
    case 'appearance':
    case 'chat':
    case 'shortcuts':
    case 'sessions':
    case 'notifications':
    case 'tunnel': {
      const section = openChamberSectionBySlug[slug] ?? 'visual';
      return <PiChamberPage section={section} />;
    }
    case 'home':
    default:
      return null;
  }
}
