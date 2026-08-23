import { beforeEach, describe, expect, test } from 'bun:test';

import type { MobileAppActions } from '@/apps/mobileAppContext';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useUIStore } from '@/stores/useUIStore';
import { openSkillSettings } from './openSkillSettings';

describe('openSkillSettings', () => {
  beforeEach(() => {
    useSkillsStore.setState({ selectedSkillName: null });
    useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'general' });
  });

  test('opens the selected skill in shared Settings', () => {
    openSkillSettings('unslop', null);

    expect(useSkillsStore.getState().selectedSkillName).toBe('unslop');
    expect(useUIStore.getState().settingsPage).toBe('skills.installed');
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
  });

  test('routes dedicated mobile to the Settings content page', () => {
    const openedSections: Array<string | undefined> = [];
    const mobileActions: MobileAppActions = {
      openChanges: () => {},
      openFiles: () => {},
      openSettings: (section) => openedSections.push(section),
    };

    openSkillSettings('code-review', mobileActions);

    expect(useSkillsStore.getState().selectedSkillName).toBe('code-review');
    expect(useUIStore.getState().settingsPage).toBe('skills.installed');
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    expect(openedSections).toEqual(['skills.installed']);
  });

  test('ignores an empty skill name', () => {
    openSkillSettings('   ', null);

    expect(useSkillsStore.getState().selectedSkillName).toBeNull();
    expect(useUIStore.getState().settingsPage).toBe('general');
  });
});
