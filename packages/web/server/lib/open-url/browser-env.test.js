import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLauncherScript,
  ensureOpenUrlBrowser,
  installOpenUrlBrowser,
  isSafeBrowserCommandPath,
  listLauncherDirectories,
  OPEN_URL_SOCKET_ENV,
  ORIGINAL_BROWSER_ENV,
} from './browser-env.js';

const temporaryDirs = [];
const makeTemporaryDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pc-open-url-'));
  temporaryDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('isSafeBrowserCommandPath', () => {
  it('rejects paths that $BROWSER consumers would split or mangle', () => {
    expect(isSafeBrowserCommandPath('/run/user/1000/pichamber/pichamber-open-url')).toBe(true);
    expect(isSafeBrowserCommandPath('/Users/a/Library/Application Support/x')).toBe(false);
    expect(isSafeBrowserCommandPath('/a:b/x')).toBe(false);
    expect(isSafeBrowserCommandPath("/a'b/x")).toBe(false);
    expect(isSafeBrowserCommandPath('')).toBe(false);
  });
});

describe('listLauncherDirectories', () => {
  it('orders the socket directory, the private directory, then a fresh temp directory, skipping unsafe paths', () => {
    expect(listLauncherDirectories({ socketPath: '/run/pc/open-url.sock', privateDir: '/home/a/.pc/d', tmpdir: '/tmp' })).toEqual([
      { dir: '/run/pc', temporary: false },
      { dir: '/home/a/.pc/d', temporary: false },
      { dir: '/tmp', temporary: true },
    ]);
    expect(listLauncherDirectories({ socketPath: '/Users/a/Application Support/open-url.sock', tmpdir: '/tmp' }))
      .toEqual([{ dir: '/tmp', temporary: true }]);
    expect(listLauncherDirectories({ socketPath: '/x y/open-url.sock', tmpdir: '/t m p' })).toEqual([]);
  });
});

describe('buildLauncherScript', () => {
  it('quotes paths and runs Electron as Node when asked', () => {
    const script = buildLauncherScript({ execPath: "/opt/Pi Chamber/it's", handlerPath: '/h.mjs', runAsNode: true });
    expect(script).toContain(`exec env ELECTRON_RUN_AS_NODE=1 '/opt/Pi Chamber/it'\\''s' '/h.mjs' "$@"`);
    expect(buildLauncherScript({ execPath: '/usr/bin/node', handlerPath: '/h.mjs', runAsNode: false }))
      .toContain(`exec '/usr/bin/node' '/h.mjs' "$@"`);
  });
});

describe('installOpenUrlBrowser', () => {
  it('writes a private launcher and points $BROWSER at it, keeping the original', async () => {
    const dir = await makeTemporaryDir();
    const socketPath = path.join(dir, 'open-url.sock');
    const env = { BROWSER: 'firefox' };
    const launcher = await installOpenUrlBrowser({
      socketPath, env, execPath: '/usr/bin/node', runAsNode: false, platform: 'linux', tmpdir: dir, handlerPath: '/h.mjs',
    });
    expect(launcher).toBe(path.join(dir, 'pichamber-open-url'));
    expect(env).toEqual({ BROWSER: launcher, [ORIGINAL_BROWSER_ENV]: 'firefox', [OPEN_URL_SOCKET_ENV]: socketPath });
    expect((await stat(launcher)).mode & 0o777).toBe(0o700);
    expect(await readFile(launcher, 'utf8')).toContain(`exec '/usr/bin/node' '/h.mjs' "$@"`);

    // A second install (the daemon re-reading its own env) never records
    // the launcher as the original.
    await installOpenUrlBrowser({
      socketPath, env, execPath: '/usr/bin/node', runAsNode: false, platform: 'linux', tmpdir: dir, handlerPath: '/h.mjs',
    });
    expect(env[ORIGINAL_BROWSER_ENV]).toBe('firefox');
  });

  it('records an empty original when $BROWSER was unset', async () => {
    const dir = await makeTemporaryDir();
    const env = {};
    await installOpenUrlBrowser({ socketPath: path.join(dir, 's.sock'), env, platform: 'linux', tmpdir: dir });
    expect(env[ORIGINAL_BROWSER_ENV]).toBe('');
  });

  it('refuses a directory others can write to or a symlinked one, and moves on', async () => {
    const dir = await makeTemporaryDir();
    const shared = path.join(dir, 'shared');
    await mkdir(shared, { mode: 0o700 });
    await chmod(shared, 0o777);
    const linked = path.join(dir, 'linked');
    await symlink(dir, linked);
    const privateDir = path.join(dir, 'private');
    const env = {};
    const launcher = await installOpenUrlBrowser({
      socketPath: path.join(shared, 'open-url.sock'), privateDir: linked, env, platform: 'linux', tmpdir: dir,
    });
    expect(path.dirname(launcher)).toMatch(new RegExp(`^${dir}/pichamber-open-url-`));
    expect((await stat(path.dirname(launcher))).mode & 0o777).toBe(0o700);

    const fromPrivate = await installOpenUrlBrowser({
      socketPath: path.join(shared, 'open-url.sock'), privateDir, env: {}, platform: 'linux', tmpdir: dir,
    });
    expect(fromPrivate).toBe(path.join(privateDir, 'pichamber-open-url'));
  });

  it('refuses a directory owned by another user', async () => {
    const dir = await makeTemporaryDir();
    const env = {};
    const uid = (typeof process.getuid === 'function' ? process.getuid() : 0) + 1;
    expect(await installOpenUrlBrowser({ socketPath: path.join(dir, 's.sock'), env, platform: 'linux', uid })).toBeNull();
    expect(env).toEqual({});
  });

  it('leaves the environment alone on Windows', async () => {
    const env = { BROWSER: 'x' };
    expect(await installOpenUrlBrowser({ socketPath: 'C:\\s.sock', env, platform: 'win32', tmpdir: 'C:\\t' })).toBeNull();
    expect(env).toEqual({ BROWSER: 'x' });
  });
});

describe('ensureOpenUrlBrowser', () => {
  const options = (dir, env) => ({
    socketPath: path.join(dir, 'run', 'open-url.sock'), env, execPath: '/usr/bin/node', runAsNode: false, platform: 'linux', handlerPath: '/h.mjs',
  });

  it('keeps an intact launcher and reinstalls one that was removed or changed', async () => {
    const dir = await makeTemporaryDir();
    const env = { BROWSER: 'firefox' };
    const launcher = await ensureOpenUrlBrowser(options(dir, env));
    expect(env.BROWSER).toBe(launcher);
    await expect(ensureOpenUrlBrowser(options(dir, env))).resolves.toBe(launcher);

    await rm(path.dirname(launcher), { recursive: true, force: true });
    await expect(ensureOpenUrlBrowser(options(dir, env))).resolves.toBe(launcher);
    expect(await readFile(launcher, 'utf8')).toContain(`'/h.mjs'`);

    await writeFile(launcher, '#!/bin/sh\necho changed\n');
    await ensureOpenUrlBrowser(options(dir, env));
    expect(await readFile(launcher, 'utf8')).toContain(`'/h.mjs'`);
    expect(env[ORIGINAL_BROWSER_ENV]).toBe('firefox');
  });

  it('gives $BROWSER back to the user when no private directory can hold the launcher', async () => {
    const dir = await makeTemporaryDir();
    const env = { BROWSER: 'firefox' };
    await ensureOpenUrlBrowser(options(dir, env));
    const runDir = path.join(dir, 'run');
    await rm(runDir, { recursive: true, force: true });
    await mkdir(runDir, { mode: 0o700 });
    await chmod(runDir, 0o777);
    await ensureOpenUrlBrowser(options(dir, env));
    expect(env).toEqual({ BROWSER: 'firefox' });

    const unset = {};
    await ensureOpenUrlBrowser(options(dir, unset));
    expect(unset).toEqual({});
  });
});
