import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  attachDevServerLifecycle,
  buildDevServerCommand,
  forwardSignalToChild,
  resolveDevServerCommand,
  resolveSignalExitCode,
  startDevServerChild,
} from './dev-server.js';

function createMockChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal ?? 'SIGTERM');
    return true;
  };
  return child;
}

function createMockProcess() {
  const proc = new EventEmitter();
  proc.platform = 'linux';
  proc.env = { PICHAMBER_SERVER_PROFILE_KIND: 'dev' };
  return proc;
}

function createSilentLogger() {
  return { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
}

describe('dev server runtime', () => {
  it('builds the server command from the resolved executable', () => {
    const command = buildDevServerCommand(
      { runtime: 'node', executable: '/mock/node' },
      '/app/server/index.js',
      ['--port', '3001'],
    );
    expect(command).toEqual({
      executable: '/mock/node',
      args: ['/app/server/index.js', '--port', '3001'],
    });
  });

  it('resolves the runtime once per start', () => {
    let resolveCalls = 0;
    const command = resolveDevServerCommand({
      resolveFn: () => {
        resolveCalls += 1;
        return { runtime: 'bun', executable: '/mock/bun' };
      },
      serverPath: '/app/server/index.js',
      serverArgs: ['--port', '3001'],
    });
    expect(resolveCalls).toBe(1);
    expect(command).toEqual({
      runtime: 'bun',
      executable: '/mock/bun',
      args: ['/app/server/index.js', '--port', '3001'],
    });
  });

  it('spawns once with the resolved executable and server args', () => {
    let resolveCalls = 0;
    const spawned = [];
    const { command, child } = startDevServerChild({
      resolveFn: () => {
        resolveCalls += 1;
        return { runtime: 'node', executable: '/mock/node' };
      },
      spawnFn: (executable, args, options) => {
        spawned.push({ executable, args, options });
        return { pid: 4242, on() {}, kill() {} };
      },
      serverPath: '/app/server/index.js',
      serverArgs: ['--port', '3001'],
      env: { PICHAMBER_SERVER_PROFILE_KIND: 'dev' },
    });
    expect(resolveCalls).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].executable).toBe('/mock/node');
    expect(spawned[0].args).toEqual(['/app/server/index.js', '--port', '3001']);
    expect(spawned[0].options.env.PICHAMBER_SERVER_PROFILE_KIND).toBe('dev');
    expect(command.executable).toBe('/mock/node');
    expect(child.pid).toBe(4242);
  });
});

describe('dev server signal exit codes', () => {
  it('uses conventional 128+signal codes', () => {
    expect(resolveSignalExitCode('SIGINT')).toBe(130);
    expect(resolveSignalExitCode('SIGTERM')).toBe(143);
    expect(resolveSignalExitCode('SIGHUP')).toBe(129);
    expect(resolveSignalExitCode('SIGQUIT')).toBe(131);
    expect(resolveSignalExitCode('SIGUSR2')).toBe(140);
  });

  it('does not forward when the child already exited', () => {
    const exited = createMockChild();
    exited.exitCode = 0;
    expect(forwardSignalToChild(exited, 'SIGINT')).toBe(false);
    expect(exited.killCalls).toHaveLength(0);
  });

  it('tolerates a kill failure without throwing', () => {
    const child = createMockChild();
    child.kill = () => { throw new Error('ESRCH'); };
    expect(forwardSignalToChild(child, 'SIGTERM')).toBe(false);
  });
});

describe('dev server lifecycle (isolated fixtures, never the prod server)', () => {
  it('propagates a nonzero child exit code', () => {
    const child = createMockChild();
    const proc = createMockProcess();
    const exitCodes = [];
    attachDevServerLifecycle({
      child,
      command: { runtime: 'node', executable: '/mock/node' },
      processRef: proc,
      exitFn: (code) => { exitCodes.push(code); },
      logger: createSilentLogger(),
    });
    child.emit('exit', 3, null);
    expect(exitCodes).toEqual([3]);
  });

  it('maps a child signal exit to the conventional code', () => {
    const child = createMockChild();
    const proc = createMockProcess();
    const exitCodes = [];
    attachDevServerLifecycle({
      child,
      command: { runtime: 'node', executable: '/mock/node' },
      processRef: proc,
      exitFn: (code) => { exitCodes.push(code); },
      logger: createSilentLogger(),
    });
    child.emit('exit', null, 'SIGTERM');
    expect(exitCodes).toEqual([143]);
  });

  it('fails explicitly when the resolver has no supported runtime', () => {
    expect(() => startDevServerChild({
      resolveFn: () => { throw new Error('No supported server runtime found. Install Node.js 22.19.0 or newer, or Bun 1.4.0 or newer.'); },
      spawnFn: () => { throw new Error('should not spawn without a runtime'); },
      serverPath: '/tmp/fake-dev-server-index.js',
      serverArgs: ['--port', '3902'],
    })).toThrow('No supported server runtime');
  });

  it('fails explicitly when spawn throws synchronously', () => {
    expect(() => startDevServerChild({
      resolveFn: () => ({ runtime: 'node', executable: '/mock/node' }),
      spawnFn: () => { throw new Error('spawn ENOENT'); },
      serverPath: '/tmp/fake-dev-server-index.js',
      serverArgs: ['--port', '3902'],
    })).toThrow('spawn ENOENT');
  });

  it('exits 1 once on async spawn error even if exit follows', () => {
    const child = createMockChild();
    const proc = createMockProcess();
    const exitCodes = [];
    const logger = createSilentLogger();
    attachDevServerLifecycle({
      child,
      command: { runtime: 'node', executable: '/mock/node' },
      processRef: proc,
      exitFn: (code) => { exitCodes.push(code); },
      logger,
    });
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('exit', 1, null);
    expect(exitCodes).toEqual([1]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('forwards SIGINT and preserves 130 even when the backend exits 0 (process-group double delivery)', () => {
    const child = createMockChild();
    const proc = createMockProcess();
    const exitCodes = [];
    attachDevServerLifecycle({
      child,
      command: { runtime: 'node', executable: '/mock/node' },
      processRef: proc,
      exitFn: (code) => { exitCodes.push(code); },
      logger: createSilentLogger(),
    });
    proc.emit('SIGINT');
    expect(child.killCalls).toEqual(['SIGINT']);
    // Backend also received SIGINT directly from the terminal group and shut
    // down gracefully with code 0; the launcher still reports 130.
    child.emit('exit', 0, null);
    expect(exitCodes).toEqual([130]);
  });

  it('forwards SIGTERM and exits 143 after backend cleanup', () => {
    const child = createMockChild();
    const proc = createMockProcess();
    const exitCodes = [];
    attachDevServerLifecycle({
      child,
      command: { runtime: 'bun', executable: '/mock/bun' },
      processRef: proc,
      exitFn: (code) => { exitCodes.push(code); },
      logger: createSilentLogger(),
    });
    proc.emit('SIGTERM');
    expect(child.killCalls).toEqual(['SIGTERM']);
    child.emit('exit', null, 'SIGTERM');
    expect(exitCodes).toEqual([143]);
  });

  it('forwards SIGUSR2 for nodemon restart and exits 140', () => {
    const child = createMockChild();
    const proc = createMockProcess();
    const exitCodes = [];
    attachDevServerLifecycle({
      child,
      command: { runtime: 'bun', executable: '/mock/bun' },
      processRef: proc,
      exitFn: (code) => { exitCodes.push(code); },
      logger: createSilentLogger(),
    });
    proc.emit('SIGUSR2');
    expect(child.killCalls).toEqual(['SIGUSR2']);
    child.emit('exit', null, 'SIGUSR2');
    expect(exitCodes).toEqual([140]);
  });

  it('handles repeated SIGINT idempotently with a single exit', () => {
    const child = createMockChild();
    const proc = createMockProcess();
    const exitCodes = [];
    attachDevServerLifecycle({
      child,
      command: { runtime: 'node', executable: '/mock/node' },
      processRef: proc,
      exitFn: (code) => { exitCodes.push(code); },
      logger: createSilentLogger(),
    });
    proc.emit('SIGINT');
    proc.emit('SIGINT');
    child.emit('exit', 0, null);
    expect(exitCodes).toEqual([130]);
  });
});
