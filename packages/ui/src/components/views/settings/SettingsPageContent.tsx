import React from 'react';
import { BehaviorPage } from '@/components/sections/behavior/BehaviorPage';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { ProjectsPage } from '@/components/sections/projects/ProjectsPage';
import { RemoteInstancesPage } from '@/components/sections/remote-instances/RemoteInstancesPage';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { SnippetsPage } from '@/components/sections/snippets/SnippetsPage';
import { GitPage } from '@/components/sections/git-identities/GitPage';
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
};

export function SettingsPageContent({
  slug,
  isMobile,
  runtimeCtx,
  openChamberSectionBySlug,
}: SettingsPageContentProps): React.ReactNode {
  const meta = getSettingsPageMeta(slug);
  if (meta && !isPageAvailable(meta, runtimeCtx)) {
    return <SettingsUnavailableView />;
  }

  switch (slug) {
    case 'projects':
      return <ProjectsPage />;
    case 'remote-instances':
      return <RemoteInstancesPage />;
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
    case 'dictation':
      return <DictationSettings />;
    case 'git':
      return <GitPage />;
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
