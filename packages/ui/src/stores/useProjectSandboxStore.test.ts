import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { piClient, PiRequestError } from '@/lib/pi/client';
import type { PiProjectSandboxState } from '@/lib/pi/protocol';
import { useProjectSandboxStore } from './useProjectSandboxStore';

const original = {
  getSandboxStatus: piClient.getSandboxStatus,
  recheckSandbox: piClient.recheckSandbox,
  listProjectSandboxes: piClient.listProjectSandboxes,
  setProjectSandbox: piClient.setProjectSandbox,
  getSandboxDefaults: piClient.getSandboxDefaults,
  setSandboxDefaults: piClient.setSandboxDefaults,
};

const project = (overrides: Partial<PiProjectSandboxState> = {}): PiProjectSandboxState => ({
  projectId: 'p1',
  mode: 'nono',
  launcher: 'nono',
  availability: { state: 'available' },
  allowHosts: [],
  allowLocalPorts: [],
  extraFolders: [],
  ...overrides,
});

beforeEach(() => {
  useProjectSandboxStore.getState().reset();
});

afterEach(() => {
  Object.assign(piClient, original);
});

describe('useProjectSandboxStore', () => {
  test('loads projects keyed by id', async () => {
    piClient.listProjectSandboxes = async () => ({ projects: [project()] });
    await useProjectSandboxStore.getState().loadProjects();
    const state = useProjectSandboxStore.getState();
    expect(state.projectsStatus).toBe('ready');
    expect(state.projects.p1?.mode).toBe('nono');
  });

  test('a failed load is not an empty list', async () => {
    piClient.listProjectSandboxes = async () => { throw new PiRequestError('SANDBOX_REQUEST_FAILED', 'x', 500); };
    await useProjectSandboxStore.getState().loadProjects();
    expect(useProjectSandboxStore.getState().projectsStatus).toBe('failed');
  });

  test('recheck refreshes launchers and then every project', async () => {
    piClient.recheckSandbox = async () => ({ launchers: [{ id: 'nono', available: true, version: '0.82.0' }] });
    piClient.listProjectSandboxes = async () => ({ projects: [project()] });
    await useProjectSandboxStore.getState().recheck();
    const state = useProjectSandboxStore.getState();
    expect(state.launchers).toEqual([{ id: 'nono', available: true, version: '0.82.0' }]);
    expect(state.rechecking).toBe(false);
    expect(state.projects.p1?.availability.state).toBe('available');
  });

  test('a refused save keeps the old state and records why', async () => {
    piClient.listProjectSandboxes = async () => ({ projects: [project({ mode: 'off', availability: { state: 'off' } })] });
    await useProjectSandboxStore.getState().loadProjects();
    piClient.setProjectSandbox = async () => { throw new PiRequestError('INVALID_SANDBOX_SETTING', 'bad', 400); };
    const saved = await useProjectSandboxStore.getState().saveProject('p1', { mode: 'nono', allowHosts: ['bad host'] });
    const state = useProjectSandboxStore.getState();
    expect(saved).toBe(false);
    expect(state.projects.p1?.mode).toBe('off');
    expect(state.saveErrors.p1).toContain('refused');
    expect(state.saving.p1).toBeUndefined();
  });

  test('a refused save names the part the server refused', async () => {
    const refuse = async (reason?: string) => {
      piClient.setProjectSandbox = async () => { throw new PiRequestError('INVALID_SANDBOX_SETTING', 'bad', 400, reason); };
      await useProjectSandboxStore.getState().saveProject('p1', { mode: 'nono' });
      return useProjectSandboxStore.getState().saveErrors.p1;
    };
    expect(await refuse('HOSTS')).toContain('allowed host');
    expect(await refuse('PORTS')).toContain('1 to 65535');
    expect(await refuse('REFUSED_PORT')).toContain('80 and 443');
    expect(await refuse('FOLDERS')).toContain('extra folder');
    expect(await refuse('SOMETHING_NEW')).toContain('Check the hosts, ports and folders');
    expect(await refuse()).toContain('Check the hosts, ports and folders');
  });

  test('a successful save takes the server answer and clears the error', async () => {
    piClient.setProjectSandbox = async () => { throw new PiRequestError('INVALID_SANDBOX_SETTING', 'bad', 400); };
    await useProjectSandboxStore.getState().saveProject('p1', { mode: 'nono' });
    piClient.setProjectSandbox = async () => project({ availability: { state: 'unavailable', reason: 'NO_LANDLOCK' } });
    expect(await useProjectSandboxStore.getState().saveProject('p1', { mode: 'nono' })).toBe(true);
    const state = useProjectSandboxStore.getState();
    expect(state.saveErrors.p1).toBeUndefined();
    expect(state.projects.p1?.availability).toEqual({ state: 'unavailable', reason: 'NO_LANDLOCK' });
  });

  test('an answer that arrives after a reset (runtime switch) is dropped', async () => {
    let resolve: (value: { projects: PiProjectSandboxState[] }) => void = () => {};
    piClient.listProjectSandboxes = () => new Promise((done) => { resolve = done; });
    const pending = useProjectSandboxStore.getState().loadProjects();
    useProjectSandboxStore.getState().reset();
    resolve({ projects: [project()] });
    await pending;
    const state = useProjectSandboxStore.getState();
    expect(state.projectsStatus).toBe('idle');
    expect(state.projects).toEqual({});
  });

  test('a list requested before a save does not overwrite the saved state', async () => {
    let answerOld: (value: { projects: PiProjectSandboxState[] }) => void = () => {};
    let lists = 0;
    piClient.listProjectSandboxes = () => {
      lists += 1;
      // The first list was answered while the project was still off.
      if (lists === 1) return new Promise((resolve) => { answerOld = resolve; });
      return Promise.resolve({ projects: [project({ mode: 'nono' })] });
    };
    piClient.setProjectSandbox = async () => project({ mode: 'nono' });
    const loading = useProjectSandboxStore.getState().loadProjects();
    await useProjectSandboxStore.getState().saveProject('p1', { mode: 'nono', allowHosts: [], allowLocalPorts: [], extraFolders: [] });
    answerOld({ projects: [project({ mode: 'off', availability: { state: 'off' } })] });
    await loading;
    expect(useProjectSandboxStore.getState().projects.p1?.mode).toBe('nono');
    expect(lists).toBe(2);
  });

  test('a default save answered after a later project save does not put the older project back', async () => {
    piClient.listProjectSandboxes = async () => ({ projects: [project({ mode: 'off', availability: { state: 'off' } })] });
    piClient.getSandboxDefaults = async () => ({ mode: 'nono', allowHosts: [] });
    let answerDefaults: (value: { defaults: { mode: 'nono'; allowHosts: string[] }; projects: PiProjectSandboxState[] }) => void = () => {};
    piClient.setSandboxDefaults = () => new Promise((resolve) => { answerDefaults = resolve; });
    piClient.setProjectSandbox = async () => project({ mode: 'off', availability: { state: 'off' } });
    const savingDefaults = useProjectSandboxStore.getState().saveDefaults({ mode: 'nono' });
    await useProjectSandboxStore.getState().saveProject('p1', { mode: 'off' });
    // The default's answer was built before the project was turned off.
    answerDefaults({ defaults: { mode: 'nono', allowHosts: [] }, projects: [project()] });
    expect(await savingDefaults).toBe(true);
    const state = useProjectSandboxStore.getState();
    expect(state.projects.p1?.mode).toBe('off');
    expect(state.defaults?.mode).toBe('nono');
    expect(state.savingDefaults).toBe(false);
  });

  test('a list requested before a save that failed uncertainly does not overwrite the reload', async () => {
    let answerOld: (value: { projects: PiProjectSandboxState[] }) => void = () => {};
    piClient.listProjectSandboxes = () => new Promise((resolve) => { answerOld = resolve; });
    const oldLoad = useProjectSandboxStore.getState().loadProjects();
    piClient.listProjectSandboxes = async () => ({ projects: [project({ mode: 'off', availability: { state: 'off' } })] });
    piClient.getSandboxDefaults = async () => ({ mode: 'off', allowHosts: [] });
    piClient.setProjectSandbox = async () => { throw new PiRequestError('SANDBOX_REQUEST_FAILED', 'x', 500); };
    await useProjectSandboxStore.getState().saveProject('p1', { mode: 'off' });
    answerOld({ projects: [project()] });
    await oldLoad;
    expect(useProjectSandboxStore.getState().projects.p1?.mode).toBe('off');
  });

  test('an older default answer that arrives after a newer one is dropped', async () => {
    let answerOld: (value: { mode: 'off'; allowHosts: string[] }) => void = () => {};
    piClient.getSandboxDefaults = () => new Promise((resolve) => { answerOld = resolve; });
    const oldLoad = useProjectSandboxStore.getState().loadDefaults();
    piClient.getSandboxDefaults = async () => ({ mode: 'off', allowHosts: [] });
    await useProjectSandboxStore.getState().loadDefaults();
    answerOld({ mode: 'off', allowHosts: ['removed.example.com'] });
    await oldLoad;
    const state = useProjectSandboxStore.getState();
    expect(state.defaults?.allowHosts).toEqual([]);
    expect(state.defaultsStatus).toBe('ready');
  });

  test('loadDefaults stores the server default', async () => {
    piClient.getSandboxDefaults = async () => ({ mode: 'nono', allowHosts: ['a.com'] });
    await useProjectSandboxStore.getState().loadDefaults();
    const state = useProjectSandboxStore.getState();
    expect(state.defaultsStatus).toBe('ready');
    expect(state.defaults).toEqual({ mode: 'nono', allowHosts: ['a.com'] });
  });

  test('a failed loadDefaults is failed, not an empty default', async () => {
    piClient.getSandboxDefaults = async () => { throw new PiRequestError('SANDBOX_REQUEST_FAILED', 'x', 500); };
    await useProjectSandboxStore.getState().loadDefaults();
    const state = useProjectSandboxStore.getState();
    expect(state.defaultsStatus).toBe('failed');
    expect(state.defaults).toBeNull();
  });

  test('saveDefaults sends only the given fields and replaces the project list', async () => {
    let sent: unknown;
    piClient.setSandboxDefaults = async (body) => {
      sent = body;
      return { defaults: { mode: 'off', allowHosts: ['a.com'] }, projects: [project({ projectId: 'p2' })] };
    };
    piClient.listProjectSandboxes = async () => ({ projects: [project()] });
    await useProjectSandboxStore.getState().loadProjects();
    expect(await useProjectSandboxStore.getState().saveDefaults({ mode: 'off' })).toBe(true);
    const state = useProjectSandboxStore.getState();
    expect(sent).toEqual({ mode: 'off' });
    expect(state.defaults?.mode).toBe('off');
    expect(Object.keys(state.projects)).toEqual(['p2']);
  });

  test('a save that fails with a 500 reloads what the server holds and keeps the error', async () => {
    piClient.setProjectSandbox = async () => { throw new PiRequestError('SANDBOX_REQUEST_FAILED', 'x', 500); };
    piClient.listProjectSandboxes = async () => ({ projects: [project({ mode: 'off', availability: { state: 'off' } })] });
    piClient.getSandboxDefaults = async () => ({ mode: 'nono', allowHosts: [] });
    expect(await useProjectSandboxStore.getState().saveProject('p1', { mode: 'off' })).toBe(false);
    const state = useProjectSandboxStore.getState();
    expect(state.projects.p1?.mode).toBe('off');
    expect(state.defaults?.mode).toBe('nono');
    expect(state.saveErrors.p1).toContain('could not be saved');
  });

  test('a default save that fails with a 500 reloads too, a refusal does not', async () => {
    let loads = 0;
    piClient.listProjectSandboxes = async () => { loads += 1; return { projects: [project()] }; };
    piClient.getSandboxDefaults = async () => ({ mode: 'nono', allowHosts: [] });
    piClient.setSandboxDefaults = async () => { throw new PiRequestError('INVALID_SANDBOX_SETTING', 'bad', 400); };
    await useProjectSandboxStore.getState().saveDefaults({ allowHosts: ['bad host'] });
    expect(loads).toBe(0);
    piClient.setSandboxDefaults = async () => { throw new PiRequestError('SANDBOX_REQUEST_FAILED', 'x', 500); };
    await useProjectSandboxStore.getState().saveDefaults({ mode: 'off' });
    expect(loads).toBe(1);
    expect(useProjectSandboxStore.getState().defaultsError).toContain('could not be saved');
  });

  test('a failed reload keeps the previous data', async () => {
    piClient.listProjectSandboxes = async () => ({ projects: [project()] });
    piClient.getSandboxDefaults = async () => ({ mode: 'nono', allowHosts: ['a.com'] });
    await useProjectSandboxStore.getState().loadProjects();
    await useProjectSandboxStore.getState().loadDefaults();
    piClient.listProjectSandboxes = async () => { throw new PiRequestError('SANDBOX_REQUEST_FAILED', 'x', 500); };
    piClient.getSandboxDefaults = async () => { throw new PiRequestError('SANDBOX_REQUEST_FAILED', 'x', 500); };
    await useProjectSandboxStore.getState().loadProjects();
    await useProjectSandboxStore.getState().loadDefaults();
    const state = useProjectSandboxStore.getState();
    expect(state.projectsStatus).toBe('failed');
    expect(state.defaultsStatus).toBe('failed');
    expect(state.projects.p1?.mode).toBe('nono');
    expect(state.defaults?.allowHosts).toEqual(['a.com']);
  });
});
