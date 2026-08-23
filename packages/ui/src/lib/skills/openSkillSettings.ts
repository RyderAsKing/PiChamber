import type { MobileAppActions } from '@/apps/mobileAppContext';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useUIStore } from '@/stores/useUIStore';

export const openSkillSettings = (skillName: string, mobileActions: MobileAppActions | null): void => {
  const name = skillName.trim();
  if (!name) return;

  useSkillsStore.getState().setSelectedSkill(name);
  useUIStore.getState().setSettingsPage('skills.installed');

  if (mobileActions) {
    mobileActions.openSettings('skills.installed');
    return;
  }

  useUIStore.getState().setSettingsDialogOpen(true);
};
