import { describe, expect, test } from 'bun:test';
import { migrateSessionDisplayState } from './useSessionDisplayStore';

describe('useSessionDisplayStore migrations', () => {
  test('drops removed project sorting, display mode and archived-bucket settings', () => {
    const migrated = migrateSessionDisplayState(
      { displayMode: 'default', projectSortOrder: 'a-z', showRecentSection: false, showArchivedSessions: true },
      3,
    );

    expect('displayMode' in migrated).toBe(false);
    expect('projectSortOrder' in migrated).toBe(false);
    expect(migrated.showRecentSection).toBe(false);
    expect('showArchivedSessions' in migrated).toBe(false);
  });
});
