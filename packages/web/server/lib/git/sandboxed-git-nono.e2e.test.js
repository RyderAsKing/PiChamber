import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNonoLauncher } from '../pi/sandbox/nono-launcher.js';
import { prepareGitSandbox } from '../pi/sandbox/project-sandbox.js';
import { setGitSandboxResolver } from './sandboxed-git.js';
import { getStatus } from './service.js';

// Runs only where nono can sandbox (Linux with Landlock and nono >= 0.82.0).
// CI and the development container have no Landlock, so this skips there;
// run it on a Landlock machine before a release.
const launcher = createNonoLauncher();
const probe = await launcher.probe();

describe.skipIf(!probe.available)('Git panel git under real nono', () => {
  const roots = [];
  afterEach(() => {
    setGitSandboxResolver(null);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs a repo core.fsmonitor command inside the sandbox when the Git panel polls status', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-git-nono-'));
    roots.push(root);
    const dataDir = path.join(root, 'data');
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
    // What a sandboxed agent could write into the repo config: a command
    // that leaves one marker in the project and one outside it.
    const inside = path.join(project, 'fsmonitor-inside');
    const escaped = path.join(outside, 'fsmonitor-outside');
    execFileSync('git', ['config', 'core.fsmonitor', `touch '${inside}'; touch '${escaped}'; false`], { cwd: project });

    const sandbox = await prepareGitSandbox({ dataDir, projectRoot: project });
    setGitSandboxResolver(async (directory) => (directory.startsWith(project) ? {
      binDir: sandbox.binDir,
      prepare: ({ argv, env }) => launcher.prepare({ argv, env, grants: sandbox.grants, network: sandbox.network, tmpDir: sandbox.tmpDir }),
    } : null));

    const status = await getStatus(project);

    expect(status.files.map((file) => file.path)).toContain('a.txt');
    expect(fs.existsSync(inside)).toBe(true);
    expect(fs.existsSync(escaped)).toBe(false);
  }, 60_000);
});
