import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveProjectCommand, setGitSandboxResolver } from './sandboxed-git.js';
import { getDiff, getStatus, isGitRepository } from './service.js';

const tempDirs = [];
const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-sandboxed-git-'));
  tempDirs.push(dir);
  return dir;
};

const createRepo = () => {
  const repo = createTempDir();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  return repo;
};

// A stand-in launcher: its prepared command is a script that records each
// command line it is asked to run, then runs it, as a sandbox would.
const createRecordingLauncher = () => {
  const dir = createTempDir();
  const log = path.join(dir, 'launched.log');
  const runner = path.join(dir, 'runner.sh');
  fs.writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec "$@"\n`, { mode: 0o755 });
  const prepared = [];
  return {
    binDir: path.join(dir, 'bin'),
    prepare: async ({ argv, env }) => {
      prepared.push(argv);
      return { command: runner, args: argv, env: { ...env, SANDBOX_MARK: '1' } };
    },
    launched: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
    prepared,
  };
};

afterEach(() => {
  setGitSandboxResolver(null);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('git for sandboxed projects', () => {
  it('runs Git panel commands through the launcher for a sandboxed project', async () => {
    const repo = createRepo();
    const launcher = createRecordingLauncher();
    setGitSandboxResolver(async (directory) => (path.resolve(directory) === repo ? launcher : null));

    const status = await getStatus(repo);
    expect(status.files.map((file) => file.path)).toContain('a.txt');
    await getDiff(repo, { path: 'a.txt' });

    const launched = launcher.launched();
    expect(launched.some((line) => /\bstatus\b/.test(line))).toBe(true);
    expect(launched.some((line) => /\bdiff\b/.test(line))).toBe(true);
  });

  it('leaves git for an unsandboxed project unchanged', async () => {
    const repo = createRepo();
    const other = createRepo();
    const launcher = createRecordingLauncher();
    setGitSandboxResolver(async (directory) => (path.resolve(directory) === other ? launcher : null));

    expect(await isGitRepository(repo)).toBe(true);
    await getStatus(repo);
    expect(launcher.launched()).toEqual([]);
  });

  it('fails closed with SANDBOX_UNAVAILABLE and never runs git unsandboxed', async () => {
    const repo = createRepo();
    // A repo hook a sandboxed agent could have written.
    const marker = path.join(createTempDir(), 'fsmonitor-ran');
    execFileSync('git', ['config', 'core.fsmonitor', `touch '${marker}'; false`], { cwd: repo });
    setGitSandboxResolver(async () => {
      throw Object.assign(new Error('The project sandbox is unavailable.'), { code: 'SANDBOX_UNAVAILABLE', reason: 'NO_LANDLOCK' });
    });

    await expect(getStatus(repo)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', reason: 'NO_LANDLOCK' });
    await expect(getDiff(repo, { path: 'a.txt' })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('starts repo hooks and start commands through the launcher only for sandboxed folders', async () => {
    const repo = createRepo();
    const launcher = createRecordingLauncher();
    setGitSandboxResolver(async (directory) => (directory === repo ? launcher : null));
    const hook = { command: path.join(repo, '.git/hooks/post-checkout'), args: ['a', 'b'], env: { A: '1' } };

    const sandboxed = await resolveProjectCommand(repo, hook);
    expect(sandboxed.args).toEqual([hook.command, 'a', 'b']);
    expect(sandboxed.env.SANDBOX_MARK).toBe('1');
    expect(await resolveProjectCommand(createTempDir(), hook)).toEqual(hook);
  });
});
