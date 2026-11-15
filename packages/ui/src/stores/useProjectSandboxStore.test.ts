import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { piClient, PiRequestError } from '@/lib/pi/client';
import type { PiProjectSandboxState } from '@/lib/pi/protocol';
import { useProjectSandboxStore } from './useProjectSandboxStore';

const original = {
  getSandboxStatus: piClient.getSandboxStatus,
  recheckSandbox: piClient.recheckSandbox,
  listProjectSandboxes: piClient.listProjectSandboxes,
  setProjectSandbox: piClient.setProjectSandbox,
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
});
