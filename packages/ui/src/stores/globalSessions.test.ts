import { describe, expect, test } from 'bun:test';
import { splitGlobalSessionsByArchived } from './globalSessions';

describe('splitGlobalSessionsByArchived', () => {
  test('classifies restored (falsy archived) records as active', () => {
    const { active, archived } = splitGlobalSessionsByArchived([
      { id: 'ses_active', time: { created: 1, updated: 20 } },
      { id: 'ses_archived', time: { created: 1, updated: 10, archived: 15 } },
      { id: 'ses_restored', time: { created: 1, updated: 5, archived: 0 } },
    ] as unknown as Parameters<typeof splitGlobalSessionsByArchived>[0]);

    expect(active.map((session) => session.id)).toEqual(['ses_active', 'ses_restored']);
    expect(archived.map((session) => session.id)).toEqual(['ses_archived']);
  });
});
