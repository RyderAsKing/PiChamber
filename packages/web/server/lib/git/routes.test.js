import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitLibraries = {
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  checkoutBranch: vi.fn(),
  getWorktrees: vi.fn(),
  validateWorktreeCreate: vi.fn(),
  createWorktree: vi.fn(),
  getWorktreeBootstrapStatus: vi.fn(),
};

vi.mock('./index.js', () => ({
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  isGitRepository: gitLibraries.isGitRepository,
  getStatus: gitLibraries.getStatus,
  checkoutBranch: gitLibraries.checkoutBranch,
  getWorktrees: gitLibraries.getWorktrees,
  validateWorktreeCreate: gitLibraries.validateWorktreeCreate,
  createWorktree: gitLibraries.createWorktree,
  getWorktreeBootstrapStatus: gitLibraries.getWorktreeBootstrapStatus,
}));

const { registerGitRoutes } = await import('./routes.js');

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('git routes index mutations', () => {
  beforeEach(() => {
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.checkoutBranch.mockReset();
    gitLibraries.getWorktrees.mockReset();
    gitLibraries.validateWorktreeCreate.mockReset();
    gitLibraries.createWorktree.mockReset();
    gitLibraries.getWorktreeBootstrapStatus.mockReset();
  });

  it('lists worktrees without converting failures into an empty result', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();
    gitLibraries.getWorktrees.mockResolvedValue([{ path: '/repo-task', branch: 'task' }]);

    await getRoute('GET', '/api/git/worktrees')(
      { query: { directory: '/repo' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ worktrees: [{ path: '/repo-task', branch: 'task' }] });
    expect(gitLibraries.getWorktrees).toHaveBeenCalledWith('/repo');

    const failed = createMockResponse();
    gitLibraries.getWorktrees.mockRejectedValueOnce(new Error('registry unavailable'));
    await getRoute('GET', '/api/git/worktrees')(
      { query: { directory: '/repo' } },
      failed,
    );
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toEqual({ error: 'registry unavailable' });
  });

  it('creates and polls a worktree through explicit routes', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const created = {
      path: '/repo-task',
      branch: 'pichamber/task',
      bootstrapStatus: { status: 'pending', phase: 'directory-created' },
    };
    gitLibraries.createWorktree.mockResolvedValue(created);
    gitLibraries.getWorktreeBootstrapStatus.mockResolvedValue({ status: 'ready', phase: 'setup-ready' });

    const createResponse = createMockResponse();
    await getRoute('POST', '/api/git/worktrees')(
      { query: { directory: '/repo' }, body: { mode: 'new', startRef: 'main' } },
      createResponse,
    );
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.body).toEqual(created);

    const statusResponse = createMockResponse();
    await getRoute('GET', '/api/git/worktrees/bootstrap-status')(
      { query: { directory: '/repo-task' } },
      statusResponse,
    );
    expect(statusResponse.body).toEqual({ status: 'ready', phase: 'setup-ready' });
  });

  it('accepts legacy stage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('forwards conditional local-only checkout options', async () => {
    gitLibraries.checkoutBranch.mockResolvedValue({
      success: true,
      branch: 'feature',
      previousBranch: 'main',
      currentBranch: 'feature',
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/checkout')(
      {
        query: { directory: '/repo' },
        body: { branch: 'feature', expectedCurrent: 'main', localOnly: true },
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.checkoutBranch).toHaveBeenCalledWith('/repo', 'feature', {
      expectedCurrent: 'main',
      localOnly: true,
    });
  });

  it('rejects malformed checkout preconditions before calling git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/checkout')(
      {
        query: { directory: '/repo' },
        body: { branch: 'feature', expectedCurrent: 42, localOnly: 'true' },
      },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(gitLibraries.checkoutBranch).not.toHaveBeenCalled();
  });

  it('returns structured checkout conflicts', async () => {
    gitLibraries.checkoutBranch.mockRejectedValue(Object.assign(
      new Error('The current branch changed.'),
      { statusCode: 409, code: 'BRANCH_CHANGED', currentBranch: 'release' },
    ));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/checkout')(
      {
        query: { directory: '/repo' },
        body: { branch: 'feature', expectedCurrent: 'main', localOnly: true },
      },
      response,
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'The current branch changed.',
      code: 'BRANCH_CHANGED',
      currentBranch: 'release',
    });
  });

  it('rejects invalid path payloads before calling git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: [' ', null] } },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path parameter is required' });
    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
  });
});

describe('git routes status discovery', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
  });

  it('returns a soft non-repo payload for non-git folders', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(false);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/tmp/not-a-repo' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      isGitRepository: false,
      files: [],
      branch: null,
      ahead: 0,
      behind: 0,
    });
    expect(gitLibraries.getStatus).not.toHaveBeenCalled();
  });

  it('does not abort when getStatus throws a non-repo GitError', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockRejectedValue(
      Object.assign(new Error('fatal: not a git repository (or any of the parent directories): .git'), {
        task: { commands: ['status'] },
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/opened/project' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ isGitRepository: false });
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/project', { mode: undefined });
  });

  it('uses the opened project path from query arrays without falling back to cwd', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockResolvedValue({ current: 'main', files: [], isClean: true, ahead: 0, behind: 0 });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: ['/opened/git-project', '/ignored'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.isGitRepository).toHaveBeenCalledWith('/opened/git-project');
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/git-project', { mode: undefined });
    expect(response.body).toMatchObject({ current: 'main' });
  });
});
