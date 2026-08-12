import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ProjectTrustDialog } from '@/components/sections/shared/ProjectTrustDialog';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useSkillsStore } from '@/stores/useSkillsStore';

/** Pi-native skill discovery. Skill files remain owned by Pi and are read-only here. */
export const SkillsPage: React.FC = () => {
  const { t } = useI18n();
  const selectedSkillName = useSkillsStore((state) => state.selectedSkillName);
  const skill = useSkillsStore((state) => state.skills.find((item) => item.name === selectedSkillName) ?? null);

  if (!skill) {
    return (<>
      <ProjectTrustDialog onResolved={() => { void useSkillsStore.getState().loadSkills(); }} />
      <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground">
        <div>
          <Icon name="book-open" className="mx-auto mb-3 size-10 opacity-50" />
          <p className="typography-body">{t('settings.skills.page.empty.title')}</p>
          <p className="typography-meta mt-1">{t('settings.skills.page.empty.description')}</p>
        </div>
      </div>
    </>);
  }

  return (
    <>
      <ProjectTrustDialog onResolved={() => { void useSkillsStore.getState().loadSkills(); }} />
    <SettingsPageLayout title={skill.name} description={skill.description} showSaveStatus={false}>
      <SettingsSection title={t('settings.skills.page.section.basicInformation')} divider={false} settingsItem="skills.discovery">
        <p className="typography-meta text-muted-foreground">
          {skill.location === 'project' ? t('settings.common.scope.project') : t('settings.common.scope.global')}
        </p>
      </SettingsSection>
    </SettingsPageLayout>
    </>
  );
};
