import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';

import {
  BUILTIN_PATH_PREFIX,
  createExtensionConfig,
  createPackageOverrideSource,
  displayPackageSource,
  getInheritedEnabled,
  getOverrideStateFromEntries,
  getProjectOverrideState,
  getResourceItemKey,
  sanitizeErrorMessage,
  setGlobalResourceEnabled,
  setProjectResourceOverride,
  stripUrlCredentials,
  togglePackageResource,
  toggleTopLevelResource,
} from './extension-config.js';

// Expected settings below follow Pi's documented filter rules
// (docs/settings.md "Resources", docs/packages.md) and the `pi config`
// screen (modes/interactive/components/config-selector.js in the SDK):
// global toggles replace any `!`/`+`/`-` entry for the resource with one
// `+`/`-` entry; project overrides name inherited files by absolute path;
// a project package override is an `autoload: false` delta.

const AGENT = '/agent';
const CWD = '/work';

const fakeSettings = ({ global = {}, project = {} } = {}) => {
  const state = { global: structuredClone(global), project: structuredClone(project) };
  const writes = [];
  const setter = (scope, key) => (value) => {
    writes.push({ scope, key });
    state[scope][key] = structuredClone(value);
  };
  return {
    state,
    writes,
    getGlobalSettings: () => structuredClone(state.global),
    getProjectSettings: () => structuredClone(state.project),
    setExtensionPaths: setter('global', 'extensions'),
    setSkillPaths: setter('global', 'skills'),
    setPromptTemplatePaths: setter('global', 'prompts'),
    setThemePaths: setter('global', 'themes'),
    setPackages: setter('global', 'packages'),
    setProjectExtensionPaths: setter('project', 'extensions'),
    setProjectSkillPaths: setter('project', 'skills'),
    setProjectPromptTemplatePaths: setter('project', 'prompts'),
    setProjectThemePaths: setter('project', 'themes'),
    setProjectPackages: setter('project', 'packages'),
  };
};

const ctxWith = (settingsManager, inherited = []) => ({
  settingsManager,
  cwd: CWD,
  agentDir: AGENT,
  inheritedEnabledByKey: new Map(inherited.map((item) => [getResourceItemKey(item), item.enabled])),
});

const userAuto = (file, enabled = true) => ({
  path: `${AGENT}/extensions/${file}`,
  enabled,
  resourceType: 'extensions',
  metadata: { source: 'auto', scope: 'user', origin: 'top-level', baseDir: AGENT },
});
const projectAuto = (file, enabled = true) => ({
  path: `${CWD}/.pi/extensions/${file}`,
  enabled,
  resourceType: 'extensions',
  metadata: { source: 'auto', scope: 'project', origin: 'top-level', baseDir: `${CWD}/.pi` },
});
const builtin = (name, enabled = true, scope = 'user') => ({
  path: `builtin:${name}`,
  enabled,
  resourceType: 'extensions',
  metadata: { source: 'builtin', scope, origin: 'top-level' },
});
const npmPackageItem = (source, file, scope = 'user', enabled = true) => {
  const root = scope === 'user' ? `${AGENT}/npm/node_modules/${source.slice(4)}` : `${CWD}/.pi/npm/node_modules/${source.slice(4)}`;
  return {
    path: `${root}/${file}`,
    enabled,
    resourceType: 'extensions',
    metadata: { source, scope, origin: 'package', baseDir: root, packageRoot: root },
  };
};

describe('global toggles (pi config global mode)', () => {
  it('turns a top-level user extension off, replacing every prefixed entry and the plain path for it', () => {
    const settings = fakeSettings({ global: { extensions: ['!extensions/foo.ts', 'other.ts', '+extensions/foo.ts', 'extensions/foo.ts'] } });
    toggleTopLevelResource(ctxWith(settings), userAuto('foo.ts'), false);
    expect(settings.state.global.extensions).toEqual(['other.ts', '-extensions/foo.ts']);
  });

  it('turns it back on with a `+` entry', () => {
    const settings = fakeSettings({ global: { extensions: ['-extensions/foo.ts'] } });
    toggleTopLevelResource(ctxWith(settings), userAuto('foo.ts', false), true);
    expect(settings.state.global.extensions).toEqual(['+extensions/foo.ts']);
  });

  it('names a settings-listed extension relative to the agent dir when it has no base dir', () => {
    const settings = fakeSettings();
    const item = { path: `${AGENT}/tools/x.ts`, enabled: true, resourceType: 'extensions', metadata: { source: 'local', scope: 'user', origin: 'top-level' } };
    toggleTopLevelResource(ctxWith(settings), item, false);
    expect(settings.state.global.extensions).toEqual(['-tools/x.ts']);
  });

  it('turns a built-in off and on with `builtin:<name>`', () => {
    const settings = fakeSettings({ global: { extensions: ['other.ts'] } });
    expect(setGlobalResourceEnabled(ctxWith(settings), builtin('mcp'), false)).toBe(true);
    expect(settings.state.global.extensions).toEqual(['other.ts', '-builtin:mcp']);
    setGlobalResourceEnabled(ctxWith(settings), builtin('mcp', false), true);
    expect(settings.state.global.extensions).toEqual(['other.ts', '+builtin:mcp']);
    expect(settings.state.project.extensions).toBeUndefined();
  });

  it('converts a string package entry to object form with a filter relative to the package root', () => {
    const settings = fakeSettings({ global: { packages: ['npm:other', 'npm:foo'] } });
    togglePackageResource(ctxWith(settings), npmPackageItem('npm:foo', 'extensions/a.ts'), false);
    expect(settings.state.global.packages).toEqual(['npm:other', { source: 'npm:foo', extensions: ['-extensions/a.ts'] }]);
    togglePackageResource(ctxWith(settings), npmPackageItem('npm:foo', 'extensions/a.ts', 'user', false), true);
    expect(settings.state.global.packages).toEqual(['npm:other', { source: 'npm:foo', extensions: ['+extensions/a.ts'] }]);
  });

  it('keeps other filters of the package entry', () => {
    const settings = fakeSettings({ global: { packages: [{ source: 'npm:foo', skills: ['x'], extensions: ['!extensions/a.ts', 'extensions/b.ts'] }] } });
    togglePackageResource(ctxWith(settings), npmPackageItem('npm:foo', 'extensions/a.ts'), true);
    expect(settings.state.global.packages).toEqual([{ source: 'npm:foo', skills: ['x'], extensions: ['extensions/b.ts', '+extensions/a.ts'] }]);
  });

  it('writes nothing when the package entry is gone', () => {
    const settings = fakeSettings({ global: { packages: [] } });
    expect(togglePackageResource(ctxWith(settings), npmPackageItem('npm:foo', 'extensions/a.ts'), false)).toBe(false);
    expect(settings.writes).toEqual([]);
  });

  it('refuses project-scope items in global scope, like pi config', () => {
    const settings = fakeSettings();
    expect(setGlobalResourceEnabled(ctxWith(settings), projectAuto('bar.ts'), false)).toBe(false);
    expect(settings.writes).toEqual([]);
  });
});

describe('project overrides (pi config project mode)', () => {
  it('cycles an inherited global file through unload, load, and inherit by absolute path', () => {
    const item = userAuto('foo.ts');
    const settings = fakeSettings({ project: { extensions: ['keep.ts'] } });
    const ctx = ctxWith(settings, [item]);
    setProjectResourceOverride(ctx, item, 'unload');
    expect(settings.state.project.extensions).toEqual(['keep.ts', `${AGENT}/extensions/foo.ts`, `-${AGENT}/extensions/foo.ts`]);
    expect(getProjectOverrideState(ctx, item)).toBe('unload');
    setProjectResourceOverride(ctx, item, 'load');
    expect(settings.state.project.extensions).toEqual(['keep.ts', `${AGENT}/extensions/foo.ts`, `+${AGENT}/extensions/foo.ts`]);
    expect(getProjectOverrideState(ctx, item)).toBe('load');
    setProjectResourceOverride(ctx, item, 'inherit');
    expect(settings.state.project.extensions).toEqual(['keep.ts']);
    expect(getProjectOverrideState(ctx, item)).toBe('inherit');
    expect(settings.state.global).toEqual({});
  });

  it('reads an override written relative to the project dir or the item base dir', () => {
    const item = userAuto('foo.ts');
    const ctx = ctxWith(fakeSettings({ project: { extensions: ['!extensions/foo.ts'] } }), [item]);
    expect(getProjectOverrideState(ctx, item)).toBe('unload');
  });

  it('writes project-declared files relative to .pi and keeps plain entries on inherit', () => {
    const item = projectAuto('bar.ts');
    const settings = fakeSettings({ project: { extensions: ['extensions/bar.ts'] } });
    const ctx = ctxWith(settings);
    setProjectResourceOverride(ctx, item, 'unload');
    expect(settings.state.project.extensions).toEqual(['extensions/bar.ts', '-extensions/bar.ts']);
    setProjectResourceOverride(ctx, item, 'load');
    expect(settings.state.project.extensions).toEqual(['extensions/bar.ts', '+extensions/bar.ts']);
    setProjectResourceOverride(ctx, item, 'inherit');
    expect(settings.state.project.extensions).toEqual(['extensions/bar.ts']);
  });

  it('overrides a built-in with `+`/`-builtin:<name>` and no plain entry', () => {
    const item = builtin('tool-search');
    const settings = fakeSettings();
    const ctx = ctxWith(settings, [item]);
    setProjectResourceOverride(ctx, item, 'unload');
    expect(settings.state.project.extensions).toEqual(['-builtin:tool-search']);
    expect(getProjectOverrideState(ctx, item)).toBe('unload');
    setProjectResourceOverride(ctx, item, 'load');
    expect(settings.state.project.extensions).toEqual(['+builtin:tool-search']);
    setProjectResourceOverride(ctx, item, 'inherit');
    expect(settings.state.project.extensions).toEqual([]);
    expect(settings.state.global).toEqual({});
  });

  it('creates an autoload:false delta for a user package and removes it when emptied', () => {
    const item = npmPackageItem('npm:foo', 'extensions/a.ts');
    const settings = fakeSettings({ project: { packages: ['npm:keep'] } });
    const ctx = ctxWith(settings, [item]);
    expect(setProjectResourceOverride(ctx, item, 'inherit')).toBe(false);
    expect(settings.writes).toEqual([]);
    setProjectResourceOverride(ctx, item, 'unload');
    expect(settings.state.project.packages).toEqual(['npm:keep', { source: 'npm:foo', autoload: false, extensions: ['-extensions/a.ts'] }]);
    expect(getProjectOverrideState(ctx, item)).toBe('unload');
    setProjectResourceOverride(ctx, item, 'load');
    expect(settings.state.project.packages).toEqual(['npm:keep', { source: 'npm:foo', autoload: false, extensions: ['+extensions/a.ts'] }]);
    setProjectResourceOverride(ctx, item, 'inherit');
    expect(settings.state.project.packages).toEqual(['npm:keep']);
    expect(settings.state.global).toEqual({});
  });

  it('collapses a project package back to its string form when no filter is left', () => {
    const item = npmPackageItem('npm:baz', 'extensions/x.ts', 'project');
    const settings = fakeSettings({ project: { packages: ['npm:baz'] } });
    const ctx = ctxWith(settings);
    setProjectResourceOverride(ctx, item, 'unload');
    expect(settings.state.project.packages).toEqual([{ source: 'npm:baz', extensions: ['-extensions/x.ts'] }]);
    setProjectResourceOverride(ctx, item, 'inherit');
    expect(settings.state.project.packages).toEqual(['npm:baz']);
  });

  it('points a local package delta at the same folder from the project .pi dir', () => {
    const item = { path: '/pkgs/demo/extensions/a.ts', enabled: true, resourceType: 'extensions', metadata: { source: '../pkgs/demo', scope: 'user', origin: 'package', baseDir: '/pkgs/demo' } };
    expect(createPackageOverrideSource(ctxWith(fakeSettings()), item)).toEqual({ source: '../../pkgs/demo', autoload: false });
  });

  it('reads override state from entries: last match wins, empty filter of a full package unloads', () => {
    const patterns = new Set(['a.ts']);
    expect(getOverrideStateFromEntries([], patterns, true)).toBe('unload');
    expect(getOverrideStateFromEntries([], patterns, false)).toBe('inherit');
    expect(getOverrideStateFromEntries(['b.ts', '-b.ts'], patterns, false)).toBe('inherit');
    expect(getOverrideStateFromEntries(['+a.ts', '-a.ts'], patterns, false)).toBe('unload');
    expect(getOverrideStateFromEntries(['-a.ts', '+a.ts'], patterns, false)).toBe('load');
    expect(getOverrideStateFromEntries(['!a.ts'], patterns, false)).toBe('unload');
    expect(getOverrideStateFromEntries(['a.ts'], patterns, false)).toBe('load');
  });

  it('takes the inherited value from the global view, else the item, else on for project items', () => {
    const off = userAuto('foo.ts', false);
    const ctx = ctxWith(fakeSettings(), [off]);
    expect(getInheritedEnabled(ctx, { ...off, enabled: true })).toBe(false);
    expect(getInheritedEnabled(ctx, userAuto('other.ts', false))).toBe(false);
    expect(getInheritedEnabled(ctx, projectAuto('bar.ts', false))).toBe(true);
  });
});

describe('display forms', () => {
  it('strips URL credentials and keeps local packages to their folder name', () => {
    expect(stripUrlCredentials('https://user:tok3n@github.com/acme/tool.git')).toBe('https://github.com/acme/tool.git');
    expect(stripUrlCredentials('git:https://x-access-token:abc@example.com/a/b@v1')).toBe('git:https://example.com/a/b@v1');
    expect(displayPackageSource('git:git@github.com:acme/tool', AGENT)).toBe('git:git@github.com:acme/tool');
    expect(displayPackageSource('npm:pi-btw@0.8.1', AGENT)).toBe('npm:pi-btw@0.8.1');
    expect(displayPackageSource('../pkgs/demo-pkg/', AGENT)).toBe('demo-pkg');
    expect(displayPackageSource('/home/someone/code/thing', AGENT)).toBe('thing');
  });

  it('removes paths and credentials from error text and caps it', () => {
    const message = sanitizeErrorMessage(
      'npm ERR! enoent /srv/agent/npm/package.json while fetching https://u:p@registry.example.com/x (C:\\Users\\me\\npm)',
      ['/srv/agent'],
    );
    expect(message).not.toContain('/srv');
    expect(message).not.toContain('u:p@');
    expect(message).not.toContain('Users');
    expect(message).toContain('https://registry.example.com/x');
    expect(sanitizeErrorMessage('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});

// Real SDK, temp agent and project dirs.
describe('createExtensionConfig with the Pi SDK', () => {
  const roots = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const setup = async ({ globalSettings = {}, projectSettings } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-extension-config-'));
    roots.push(root);
    const agentDir = join(root, 'agent');
    const project = join(root, 'project');
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await mkdir(join(project, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'foo.ts'), 'export default function () {}\n');
    await mkdir(join(agentDir, 'extensions', 'tidy'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'tidy', 'index.ts'), 'export default function () {}\n');
    await writeFile(join(project, '.pi', 'extensions', 'bar.ts'), 'export default function () {}\n');
    const pkg = join(root, 'pkgs', 'demo-pkg');
    await mkdir(join(pkg, 'extensions'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.0.0', pi: { extensions: ['./extensions'] } }));
    await writeFile(join(pkg, 'extensions', 'alpha.ts'), 'export default function () {}\n');
    await writeFile(join(pkg, 'extensions', 'beta.ts'), 'export default function () {}\n');
    // `false` as npm makes any npm call fail locally; nothing reaches a registry.
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ npmCommand: ['false'], ...globalSettings }));
    if (projectSettings) await writeFile(join(project, '.pi', 'settings.json'), JSON.stringify(projectSettings));
    return { root, agentDir, project, pkg };
  };

  const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const byName = (list) => Object.fromEntries(list.extensions.map((entry) => [entry.name, entry]));

  it('pins the built-in path prefix against what Pi resolves', async () => {
    const { agentDir, project } = await setup();
    const settingsManager = SettingsManager.create(project, agentDir, { projectTrusted: false });
    const resolved = await new DefaultPackageManager({ cwd: project, agentDir, settingsManager, builtinExtensions: ['mcp'] }).resolve(async () => 'skip');
    expect(resolved.extensions.find((entry) => entry.metadata.source === 'builtin')?.path).toBe(`${BUILTIN_PATH_PREFIX}mcp`);
  });

  it('lists the global view without installing, path-free, with stable ids', async () => {
    const { agentDir, project, root } = await setup({
      globalSettings: { packages: ['npm:pi-not-installed@1.0.0', 'https://user:s3cret@github.com/acme/tool.git', '../pkgs/demo-pkg'] },
    });
    const installSpy = vi.spyOn(DefaultPackageManager.prototype, 'installParsedSource');
    const service = createExtensionConfig({ agentDir });
    const list = await service.list({ cwd: project, trusted: false });

    expect(installSpy).not.toHaveBeenCalled();
    expect(existsSync(join(agentDir, 'npm', 'node_modules', 'pi-not-installed'))).toBe(false);
    expect(existsSync(join(agentDir, 'git'))).toBe(false);

    expect(list.project).toEqual({ available: false, trusted: false });
    expect(list.directory).toBeUndefined();
    expect(list.packages.map(({ source, scope, kind, installed, filtered }) => ({ source, scope, kind, installed, filtered }))).toEqual([
      { source: 'demo-pkg', scope: 'user', kind: 'local', installed: true, filtered: false },
      { source: 'https://github.com/acme/tool.git', scope: 'user', kind: 'git', installed: false, filtered: false },
      { source: 'npm:pi-not-installed@1.0.0', scope: 'user', kind: 'npm', installed: false, filtered: false },
    ]);
    const demo = list.packages.find((pkg) => pkg.source === 'demo-pkg');
    expect(list.extensions.map(({ name, group, scope, global }) => ({ name, group, scope, global }))).toEqual([
      { name: 'alpha.ts', group: 'package', scope: 'user', global: true },
      { name: 'beta.ts', group: 'package', scope: 'user', global: true },
      { name: 'foo.ts', group: 'auto', scope: 'user', global: true },
      { name: 'tidy/index.ts', group: 'auto', scope: 'user', global: true },
      { name: 'codemode', group: 'builtin', scope: 'user', global: true },
      { name: 'mcp', group: 'builtin', scope: 'user', global: true },
      { name: 'tool-search', group: 'builtin', scope: 'user', global: true },
    ]);
    expect(list.extensions.filter((entry) => entry.group === 'package').every((entry) => entry.packageId === demo.id)).toBe(true);
    expect(list.extensions.some((entry) => entry.name === 'llama.cpp')).toBe(false);

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('s3cret');
    for (const entry of [...list.packages, ...list.extensions]) expect(entry.id).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const again = await service.list({ cwd: project, trusted: false });
    expect(again.extensions.map((entry) => entry.id)).toEqual(list.extensions.map((entry) => entry.id));
  });

  it('maps replacement facts to item ids and keeps paths out', async () => {
    const { agentDir, project, root } = await setup();
    const service = createExtensionConfig({ agentDir });
    const target = { cwd: project, trusted: false };
    expect((await service.list(target)).replaced).toBeUndefined();

    const foo = join(agentDir, 'extensions', 'foo.ts');
    const list = await service.list(target, {
      plugins: [
        { id: 'subagents', registers: { kind: 'tool', name: 'subagent' }, by: { path: foo, name: 'foo' } },
        { id: 'visuals', registers: { kind: 'tool', name: 'render_html' }, by: { path: join(root, 'elsewhere', 'taker.ts'), name: 'taker' } },
        { id: 'bare' },
      ],
      builtins: [
        { path: 'builtin:mcp', registers: { kind: 'command', name: 'mcp' }, by: { path: foo, name: 'foo' } },
        { path: 'builtin:tool-search' },
        { path: 'builtin:unlisted' },
      ],
    });
    const fooId = list.extensions.find((entry) => entry.name === 'foo.ts').id;
    const mcpId = list.extensions.find((entry) => entry.name === 'mcp').id;
    const toolSearchId = list.extensions.find((entry) => entry.name === 'tool-search').id;
    expect(list.replaced).toEqual([
      { kind: 'plugin', id: 'subagents', registers: { kind: 'tool', name: 'subagent' }, by: { id: fooId, name: 'foo.ts' } },
      { kind: 'plugin', id: 'visuals', registers: { kind: 'tool', name: 'render_html' }, by: { name: 'taker' } },
      { kind: 'plugin', id: 'bare' },
      { kind: 'builtin', id: mcpId, registers: { kind: 'command', name: 'mcp' }, by: { id: fooId, name: 'foo.ts' } },
      { kind: 'builtin', id: toolSearchId },
    ]);
    expect(JSON.stringify(list)).not.toContain(root);
    expect((await service.list(target, { plugins: [], builtins: [] })).replaced).toEqual([]);
  });

  it('shows only the global view for an untrusted project', async () => {
    const { agentDir, project } = await setup({ projectSettings: { extensions: ['-builtin:mcp'] } });
    const list = await createExtensionConfig({ agentDir }).list({ cwd: project, directory: project, trusted: false });
    expect(list.directory).toBe(project);
    expect(list.project).toEqual({ available: true, trusted: false });
    expect(list.extensions.some((entry) => entry.project)).toBe(false);
    expect(list.extensions.some((entry) => entry.name === 'bar.ts')).toBe(false);
    expect(byName(list).mcp.global).toBe(true);
  });

  it('keeps one id per extension across the global and project views', async () => {
    const { agentDir, project } = await setup();
    const service = createExtensionConfig({ agentDir });
    const globalList = await service.list({ cwd: project, trusted: false });
    const projectList = await service.list({ cwd: project, directory: project, trusted: true });
    const projectById = new Map(projectList.extensions.map((entry) => [entry.id, entry]));
    for (const entry of globalList.extensions) {
      expect(projectById.get(entry.id)?.name).toBe(entry.name);
      expect(projectById.get(entry.id)?.project).toEqual({ state: 'inherit', inherited: true, enabled: true });
    }
    expect(byName(projectList)['bar.ts']).toMatchObject({ group: 'auto', scope: 'project', project: { state: 'inherit', inherited: true, enabled: true } });
    expect(byName(projectList)['bar.ts'].global).toBeUndefined();
  });

  it('writes global toggles that Pi then resolves', async () => {
    const { agentDir, project } = await setup({ globalSettings: { packages: ['../pkgs/demo-pkg'] } });
    const service = createExtensionConfig({ agentDir });
    const target = { cwd: project, trusted: false };
    let list = await service.list(target);
    await service.set(target, { id: byName(list)['foo.ts'].id, scope: 'global', enabled: false });
    await service.set(target, { id: byName(list).mcp.id, scope: 'global', enabled: false });
    await service.set(target, { id: byName(list)['alpha.ts'].id, scope: 'global', enabled: false });
    const settings = await readJson(join(agentDir, 'settings.json'));
    expect(settings.extensions).toEqual(['-extensions/foo.ts', '-builtin:mcp']);
    expect(settings.packages).toEqual([{ source: '../pkgs/demo-pkg', extensions: ['-extensions/alpha.ts'] }]);
    list = await service.list(target);
    expect(byName(list)['foo.ts'].global).toBe(false);
    expect(byName(list).mcp.global).toBe(false);
    expect(byName(list)['alpha.ts'].global).toBe(false);
    expect(byName(list)['beta.ts'].global).toBe(true);
    expect(list.packages[0].filtered).toBe(true);

    await service.set(target, { id: byName(list)['foo.ts'].id, scope: 'global', enabled: true });
    expect(byName(await service.list(target))['foo.ts'].global).toBe(true);
  });

  it('writes project overrides that Pi then resolves, leaving global settings alone', async () => {
    const { agentDir, project } = await setup({ globalSettings: { packages: ['../pkgs/demo-pkg'] } });
    const service = createExtensionConfig({ agentDir });
    const target = { cwd: project, directory: project, trusted: true };
    let list = await service.list(target);
    const before = await readFile(join(agentDir, 'settings.json'), 'utf8');
    await service.set(target, { id: byName(list)['foo.ts'].id, scope: 'project', state: 'unload' });
    await service.set(target, { id: byName(list)['tool-search'].id, scope: 'project', state: 'unload' });
    await service.set(target, { id: byName(list)['beta.ts'].id, scope: 'project', state: 'unload' });
    await service.set(target, { id: byName(list)['bar.ts'].id, scope: 'project', state: 'unload' });
    expect(await readFile(join(agentDir, 'settings.json'), 'utf8')).toBe(before);
    const projectSettings = await readJson(join(project, '.pi', 'settings.json'));
    expect(projectSettings.packages).toEqual([{ source: '../../pkgs/demo-pkg', autoload: false, extensions: ['-extensions/beta.ts'] }]);

    list = await service.list(target);
    expect(byName(list)['foo.ts'].project).toEqual({ state: 'unload', inherited: true, enabled: false });
    expect(byName(list)['foo.ts'].global).toBe(true);
    expect(byName(list)['tool-search'].project).toEqual({ state: 'unload', inherited: true, enabled: false });
    expect(byName(list)['beta.ts'].project).toEqual({ state: 'unload', inherited: true, enabled: false });
    expect(byName(list)['alpha.ts'].project).toEqual({ state: 'inherit', inherited: true, enabled: true });
    expect(byName(list)['bar.ts'].project).toEqual({ state: 'unload', inherited: true, enabled: false });
    // The project's `autoload: false` entry records its overrides. It is not
    // listed as a second package, and the extensions stay under the user's.
    expect(list.packages.map((pkg) => [pkg.source, pkg.scope])).toEqual([['demo-pkg', 'user']]);
    expect(byName(list)['beta.ts'].packageId).toBe(list.packages[0].id);
    expect(byName(list)['alpha.ts'].packageId).toBe(list.packages[0].id);

    for (const name of ['foo.ts', 'tool-search', 'beta.ts', 'bar.ts']) {
      await service.set(target, { id: byName(list)[name].id, scope: 'project', state: 'inherit' });
    }
    const cleaned = await readJson(join(project, '.pi', 'settings.json'));
    expect(cleaned.packages).toEqual([]);
    expect(cleaned.extensions).toEqual([]);
    list = await service.list(target);
    for (const name of ['foo.ts', 'tool-search', 'beta.ts', 'bar.ts']) {
      expect(byName(list)[name].project).toEqual({ state: 'inherit', inherited: true, enabled: true });
    }
  });

  it('turns on/off in a project into an override only when it differs from what the project gets anyway', async () => {
    const { agentDir, project } = await setup();
    const service = createExtensionConfig({ agentDir });
    const target = { cwd: project, directory: project, trusted: true };
    const stateOf = async (name) => byName(await service.list(target))[name].project;
    const { id } = byName(await service.list(target))['foo.ts'];
    const projectId = byName(await service.list(target))['bar.ts'].id;

    await service.set(target, { id, scope: 'project', enabled: false });
    expect(await stateOf('foo.ts')).toEqual({ state: 'unload', inherited: true, enabled: false });
    await service.set(target, { id, scope: 'project', enabled: true });
    expect(await stateOf('foo.ts')).toEqual({ state: 'inherit', inherited: true, enabled: true });

    // The global value moves; the same request is now a choice of the project's own.
    await service.set({ cwd: project, trusted: false }, { id, scope: 'global', enabled: false });
    await service.set(target, { id, scope: 'project', enabled: true });
    expect(await stateOf('foo.ts')).toEqual({ state: 'load', inherited: false, enabled: true });
    await service.set(target, { id, scope: 'project', enabled: false });
    expect(await stateOf('foo.ts')).toEqual({ state: 'inherit', inherited: false, enabled: false });

    // An extension the project declares is on unless the project says otherwise.
    await service.set(target, { id: projectId, scope: 'project', enabled: false });
    expect(await stateOf('bar.ts')).toEqual({ state: 'unload', inherited: true, enabled: false });
    await service.set(target, { id: projectId, scope: 'project', enabled: true });
    expect(await stateOf('bar.ts')).toEqual({ state: 'inherit', inherited: true, enabled: true });

    await expect(service.set(target, { id, scope: 'project', enabled: true, state: 'load' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.set(target, { id, scope: 'project', enabled: 'yes' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('validates set requests and rejects unknown ids and untrusted project writes', async () => {
    const { agentDir, project } = await setup();
    const service = createExtensionConfig({ agentDir });
    const list = await service.list({ cwd: project, trusted: false });
    const id = byName(list)['foo.ts'].id;
    const target = { cwd: project, trusted: false };
    await expect(service.set(target, { id, scope: 'global' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.set(target, { id, scope: 'global', enabled: 'no' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.set(target, { id, scope: 'project', state: 'off' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.set(target, { id: '../x', scope: 'global', enabled: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.set(target, { id, scope: 'project', state: 'load' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.set({ ...target, directory: project }, { id, scope: 'project', state: 'load' })).rejects.toMatchObject({ code: 'PROJECT_UNTRUSTED' });
    await expect(service.set(target, { id: 'A'.repeat(43), scope: 'global', enabled: true })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const projectList = await service.list({ cwd: project, directory: project, trusted: true });
    await expect(service.set({ cwd: project, directory: project, trusted: true }, { id: byName(projectList)['bar.ts'].id, scope: 'global', enabled: false }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('removes a local package from settings without deleting its folder', async () => {
    const { agentDir, project, pkg } = await setup({ globalSettings: { packages: ['../pkgs/demo-pkg', 'npm:keep@1.0.0'] } });
    const service = createExtensionConfig({ agentDir });
    // A working directory from which `../pkgs/demo-pkg` names another place
    // than it does from the agent directory: settings paths are relative to
    // their own folder, and Pi's removal reads a relative source against cwd.
    const target = { cwd: join(project, '.pi', 'extensions'), trusted: false };
    const list = await service.list(target);
    await service.removePackage(target, { id: list.packages.find((entry) => entry.source === 'demo-pkg').id });
    expect((await readJson(join(agentDir, 'settings.json'))).packages).toEqual(['npm:keep@1.0.0']);
    expect(existsSync(join(pkg, 'extensions', 'alpha.ts'))).toBe(true);
    await expect(service.removePackage(target, { id: list.packages[0].id })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('package removal with a stubbed package manager', () => {
  const ID_OF = async (service, target, source) => (await service.list(target)).packages.find((pkg) => pkg.source === source).id;

  const stubbed = ({ configured, remove = async () => true, drainAfterFlush = [] }) => {
    const calls = [];
    let flushed = false;
    const settingsManager = {
      flush: async () => { flushed = true; },
      drainErrors: () => (flushed ? drainAfterFlush : []),
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    };
    const packageManager = {
      resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [], installFailures: [] }),
      listConfiguredPackages: () => configured,
      removeAndPersist: async (source, options) => {
        calls.push({ source, options });
        return remove(source, options);
      },
    };
    const service = createExtensionConfig({
      agentDir: '/agent',
      createSettingsManager: () => { flushed = false; return settingsManager; },
      createPackageManager: () => packageManager,
      builtinExtensions: [],
    });
    return { service, calls };
  };

  const configured = [
    { source: 'npm:pi-btw@0.8.1', scope: 'user', filtered: false, installedPath: '/agent/npm/node_modules/pi-btw' },
    { source: 'https://tok@github.com/acme/tool', scope: 'user', filtered: true },
    { source: '../pkgs/local-one', scope: 'user', filtered: false },
    { source: 'npm:proj-pkg', scope: 'project', filtered: false },
  ];

  it.each([
    ['npm:pi-btw@0.8.1', 'npm:pi-btw@0.8.1'],
    ['https://github.com/acme/tool', 'https://tok@github.com/acme/tool'],
    // A local source goes in as the absolute path it names from the agent directory.
    ['local-one', '/pkgs/local-one'],
  ])('removes %s through removeAndPersist in user scope', async (display, source) => {
    const { service, calls } = stubbed({ configured });
    const target = { cwd: '/work', trusted: false };
    await service.removePackage(target, { id: await ID_OF(service, target, display) });
    expect(calls).toEqual([{ source, options: { local: false } }]);
  });

  it('removes a project package only with a trusted directory', async () => {
    const { service, calls } = stubbed({ configured });
    const trustedTarget = { cwd: '/work', directory: '/work', trusted: true };
    const id = await ID_OF(service, trustedTarget, 'npm:proj-pkg');
    await expect(service.removePackage({ cwd: '/work', directory: '/work', trusted: false }, { id })).rejects.toMatchObject({ code: 'PROJECT_UNTRUSTED' });
    expect(calls).toEqual([]);
    await service.removePackage(trustedTarget, { id });
    expect(calls).toEqual([{ source: 'npm:proj-pkg', options: { local: true } }]);
  });

  it('reports an unknown id, a missing settings entry, a failed npm run, and a partial failure', async () => {
    const target = { cwd: '/work', trusted: false };
    const missing = stubbed({ configured });
    await expect(missing.service.removePackage(target, { id: 'B'.repeat(43) })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(missing.service.removePackage(target, { id: 7 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const notConfigured = stubbed({ configured, remove: async () => false });
    await expect(notConfigured.service.removePackage(target, { id: await ID_OF(notConfigured.service, target, 'npm:pi-btw@0.8.1') }))
      .rejects.toMatchObject({ code: 'PACKAGE_NOT_CONFIGURED' });

    const failing = stubbed({
      configured,
      remove: async () => { throw new Error('npm uninstall pi-btw --prefix /agent/npm failed: EACCES /agent/npm/node_modules'); },
    });
    const failure = await failing.service.removePackage(target, { id: await ID_OF(failing.service, target, 'npm:pi-btw@0.8.1') }).catch((error) => error);
    expect(failure.code).toBe('PACKAGE_REMOVE_FAILED');
    expect(failure.message).not.toContain('/agent');
    expect(failure.message.length).toBeLessThanOrEqual(300);

    const partial = stubbed({ configured, drainAfterFlush: [{ scope: 'global', error: new Error('EACCES') }] });
    const partialId = await ID_OF(partial.service, target, 'npm:pi-btw@0.8.1');
    await expect(partial.service.removePackage(target, { id: partialId })).rejects.toMatchObject({ code: 'PI_SETTINGS_INVALID' });
    expect(partial.calls).toHaveLength(1);
  });
});

describe('package install and update with a stubbed package manager', () => {
  const stubbed = ({ configured = [], install = async () => {}, update = async () => {}, drainAfterFlush = [] } = {}) => {
    const calls = [];
    const state = { configured: [...configured] };
    let flushed = false;
    const settingsManager = {
      flush: async () => { flushed = true; calls.push({ op: 'flush' }); },
      drainErrors: () => (flushed ? drainAfterFlush : []),
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    };
    const packageManager = {
      resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [], installFailures: [] }),
      listConfiguredPackages: () => state.configured,
      install: async (source, options) => { calls.push({ op: 'install', source, options }); return install(source, options); },
      update: async (source) => { calls.push({ op: 'update', source }); return update(source); },
      addSourceToSettings: (source, options) => {
        calls.push({ op: 'add', source, options });
        state.configured.push({ source, scope: options.local ? 'project' : 'user', filtered: false });
        return true;
      },
    };
    const service = createExtensionConfig({
      agentDir: '/agent',
      createSettingsManager: () => { flushed = false; return settingsManager; },
      createPackageManager: () => packageManager,
      builtinExtensions: [],
    });
    return { service, calls, state };
  };
  const user = { cwd: '/work', trusted: false };
  const project = { cwd: '/work', directory: '/work', trusted: true };

  it('installs npm:<name> then writes settings under the write hook, and answers with its list id', async () => {
    const { service, calls } = stubbed();
    const order = [];
    const { installedId } = await service.installPackage(project, { name: '@acme/pi-btw', scope: 'project' }, {
      serializeInstall: async (operation) => { order.push('queue'); await operation(); order.push('queued-done'); },
      withWriteLock: async (write) => { order.push('lock'); await write(project); order.push('unlock'); },
    });
    expect(order).toEqual(['queue', 'queued-done', 'lock', 'unlock']);
    expect(calls).toEqual([
      { op: 'install', source: 'npm:@acme/pi-btw', options: { local: true } },
      { op: 'add', source: 'npm:@acme/pi-btw', options: { local: true } },
      { op: 'flush' },
    ]);
    const listed = (await service.list(project)).packages.find((pkg) => pkg.source === 'npm:@acme/pi-btw');
    expect(listed).toMatchObject({ id: installedId, scope: 'project', kind: 'npm' });
  });

  it.each([
    ['npm:pi-btw'], ['https://github.com/acme/tool'], ['git:github.com/acme/tool'], ['../x'], ['pi-btw@1.0.0'],
    ['Pi-Btw'], ['.hidden'], ['_private'], ['a'.repeat(215)], [''], [7],
  ])('refuses %s as a package name', async (name) => {
    const { service, calls } = stubbed();
    await expect(service.installPackage(user, { name, scope: 'user' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
  });

  it('refuses an untrusted or missing project, a bad scope, and an already configured package', async () => {
    const { service, calls } = stubbed({ configured: [{ source: 'npm:pi-btw@0.8.1', scope: 'user' }] });
    await expect(service.installPackage({ cwd: '/work', directory: '/work', trusted: false }, { name: 'x', scope: 'project' }))
      .rejects.toMatchObject({ code: 'PROJECT_UNTRUSTED' });
    await expect(service.installPackage(user, { name: 'x', scope: 'project' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.installPackage(user, { name: 'x', scope: 'global' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.installPackage(user, { name: 'pi-btw', scope: 'user' })).rejects.toMatchObject({ code: 'PACKAGE_ALREADY_INSTALLED' });
    expect(calls).toEqual([]);
    // The same name in the other scope is a separate package.
    await service.installPackage(project, { name: 'pi-btw', scope: 'project' });
    expect(calls.map((call) => call.op)).toEqual(['install', 'add', 'flush']);
  });

  it('checks again under the lock and writes nothing when another writer got there first', async () => {
    const { service, calls, state } = stubbed();
    await expect(service.installPackage(user, { name: 'pi-btw', scope: 'user' }, {
      withWriteLock: async (write) => {
        state.configured.push({ source: 'npm:pi-btw', scope: 'user' });
        return write(user);
      },
    })).rejects.toMatchObject({ code: 'PACKAGE_ALREADY_INSTALLED' });
    expect(calls.map((call) => call.op)).toEqual(['install']);
  });

  it('reports a failed npm run sanitized and a failed settings write after install', async () => {
    const failing = stubbed({ install: async () => { throw new Error('npm install pi-btw --prefix /agent/npm failed: EACCES /agent/npm/x'); } });
    const failure = await failing.service.installPackage(user, { name: 'pi-btw', scope: 'user' }).catch((error) => error);
    expect(failure.code).toBe('PACKAGE_INSTALL_FAILED');
    expect(failure.message).not.toContain('/agent');
    expect(failing.calls.map((call) => call.op)).toEqual(['install']);

    const partial = stubbed({ drainAfterFlush: [{ scope: 'global', error: new Error('EACCES') }] });
    await expect(partial.service.installPackage(user, { name: 'pi-btw', scope: 'user' })).rejects.toMatchObject({ code: 'PI_SETTINGS_INVALID' });
    expect(partial.calls.map((call) => call.op)).toEqual(['install', 'add', 'flush']);
  });

  const configured = [
    { source: 'npm:pi-btw', scope: 'user', filtered: false },
    { source: 'npm:pinned@1.2.3', scope: 'user', filtered: false },
    { source: 'https://tok@github.com/acme/tool', scope: 'user', filtered: false },
    { source: '../pkgs/local-one', scope: 'user', filtered: false },
    { source: 'npm:proj-pkg', scope: 'project', filtered: false },
  ];
  const idOf = async (service, target, source) => (await service.list(target)).packages.find((pkg) => pkg.source === source).id;

  it.each([
    ['npm:pi-btw', 'npm:pi-btw'],
    ['https://github.com/acme/tool', 'https://tok@github.com/acme/tool'],
  ])('updates %s through the install queue', async (display, source) => {
    const { service, calls } = stubbed({ configured });
    const queued = [];
    await service.updatePackage(user, { id: await idOf(service, user, display) }, {
      serializeInstall: async (operation) => { queued.push(true); return operation(); },
    });
    expect(queued).toHaveLength(1);
    expect(calls).toEqual([{ op: 'update', source }]);
  });

  it('refuses pinned, local, unknown, and untrusted project packages, and sanitizes failures', async () => {
    const { service, calls } = stubbed({ configured });
    const list = await service.list(user);
    expect(list.packages.find((pkg) => pkg.source === 'npm:pinned@1.2.3').pinned).toBe(true);
    expect(list.packages.find((pkg) => pkg.source === 'npm:pi-btw').pinned).toBeUndefined();
    await expect(service.updatePackage(user, { id: await idOf(service, user, 'npm:pinned@1.2.3') })).rejects.toMatchObject({ code: 'PACKAGE_PINNED' });
    await expect(service.updatePackage(user, { id: await idOf(service, user, 'local-one') })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.updatePackage(user, { id: 'B'.repeat(43) })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(service.updatePackage(user, { id: 7 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const projectId = await idOf(service, project, 'npm:proj-pkg');
    await expect(service.updatePackage({ cwd: '/work', directory: '/work', trusted: false }, { id: projectId })).rejects.toMatchObject({ code: 'PROJECT_UNTRUSTED' });
    expect(calls).toEqual([]);

    const failing = stubbed({ configured, update: async () => { throw new Error('git pull failed in /agent/git/github.com/acme/tool'); } });
    const failure = await failing.service.updatePackage(user, { id: await idOf(failing.service, user, 'npm:pi-btw') }).catch((error) => error);
    expect(failure.code).toBe('PACKAGE_UPDATE_FAILED');
    expect(failure.message).not.toContain('/agent');
  });

  it('reads trust again when a queued install or update starts, and stops when it was revoked', async () => {
    const revoked = { cwd: '/work', directory: '/work', trusted: false };
    const { service, calls } = stubbed({ configured });
    await expect(service.installPackage(project, { name: 'pi-new', scope: 'project' }, {
      resolveTarget: async () => revoked,
    })).rejects.toMatchObject({ code: 'PROJECT_UNTRUSTED' });
    const projectId = await idOf(service, project, 'npm:proj-pkg');
    await expect(service.updatePackage(project, { id: projectId }, {
      resolveTarget: async () => revoked,
    })).rejects.toMatchObject({ code: 'PROJECT_UNTRUSTED' });
    expect(calls).toEqual([]);
  });

  it('lists name, version, and the PiChamber marker from the installed package.json, ignoring a broken one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-extension-config-pkg-'));
    try {
      const good = join(root, 'good');
      const broken = join(root, 'broken');
      const odd = join(root, 'odd');
      await Promise.all([mkdir(good), mkdir(broken), mkdir(odd)]);
      await writeFile(join(good, 'package.json'), JSON.stringify({ name: '@acme/pi-btw', version: '0.8.1', pichamber: { apiVersion: 1 } }));
      await writeFile(join(broken, 'package.json'), '{ not json');
      await writeFile(join(odd, 'package.json'), JSON.stringify({ name: 'Bad Name', version: 'x'.repeat(65), pichamber: { apiVersion: '1' } }));
      const { service } = stubbed({
        configured: [
          { source: 'npm:pi-btw', scope: 'user', installedPath: good },
          { source: 'npm:broken', scope: 'user', installedPath: broken },
          { source: 'npm:odd', scope: 'user', installedPath: odd },
          { source: 'npm:missing', scope: 'user', installedPath: join(root, 'nope') },
        ],
      });
      const { packages } = await service.list(user);
      const bySource = Object.fromEntries(packages.map((pkg) => [pkg.source, pkg]));
      expect(bySource['npm:pi-btw']).toMatchObject({ name: '@acme/pi-btw', version: '0.8.1', pichamber: true, installed: true });
      for (const source of ['npm:broken', 'npm:odd', 'npm:missing']) {
        expect(Object.keys(bySource[source]).sort()).toEqual(['filtered', 'id', 'installed', 'kind', 'scope', 'source']);
      }
      expect(JSON.stringify(packages)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
