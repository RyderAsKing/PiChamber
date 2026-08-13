import { beforeEach, describe, expect, mock, test } from 'bun:test';

let resourcesImpl: () => Promise<{ skills: Array<{ id: string; name: string; description?: string; location: 'global' | 'project' | 'package' | 'path' }>; prompts: []; agents: [] }>;

mock.module('@/lib/pi/client', () => ({
  piClient: { listResources: () => resourcesImpl() },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'runtime-1' }));
mock.module('./utils/safeStorage', () => ({
  createDeferredSafeJSONStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }),
}));

const { invalidateSkillsLoadCache, useSkillsStore } = await import('./useSkillsStore');

describe('useSkillsStore', () => {
  beforeEach(() => {
    resourcesImpl = async () => ({
      skills: [{ id: 'skill-1', name: 'repo-local-skill', description: 'Repository local', location: 'project' }],
      prompts: [], agents: [],
    });
    invalidateSkillsLoadCache();
    useSkillsStore.setState({ selectedSkillName: null, skills: [], isLoading: false });
  });

  test('maps Pi resource discovery without keeping a filesystem path in UI state', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills).toEqual([{
      id: 'skill-1', name: 'repo-local-skill', path: 'skill-1', scope: 'project', source: 'agents', description: 'Repository local', location: 'project',
    }]);
  });

  test('preserves cached discovery until an explicit invalidation', async () => {
    let calls = 0;
    resourcesImpl = async () => { calls += 1; return { skills: [], prompts: [], agents: [] }; };
    await useSkillsStore.getState().loadSkills();
    await useSkillsStore.getState().loadSkills();
    expect(calls).toBe(1);
    invalidateSkillsLoadCache();
    await useSkillsStore.getState().loadSkills();
    expect(calls).toBe(2);
  });
});
