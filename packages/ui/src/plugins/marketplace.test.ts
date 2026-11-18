import { describe, expect, test } from 'bun:test';

import type { PiExtensionConfigPackage, PiExtensionConfigResponse, PiPluginView } from '@/lib/pi/protocol';

import {
  availableUpdate,
  compareVersions,
  formatCount,
  formatInstalledFacts,
  installedByName,
  matchingPlugins,
  npmNameOfSource,
} from './marketplace';

const pkg = (source: string, extra: Partial<PiExtensionConfigPackage> = {}): PiExtensionConfigPackage => ({
  id: `pkg-${source}`,
  source,
  scope: 'user',
  kind: source.startsWith('npm:') ? 'npm' : 'git',
  installed: true,
  filtered: false,
  ...extra,
});

const config = (packages: PiExtensionConfigPackage[]): PiExtensionConfigResponse => ({
  project: { available: true, trusted: true },
  packages,
  extensions: [],
  installFailures: [],
});

const plugin = (id: string, name: string, keywords: string[], bundled = true): PiPluginView => ({
  id,
  name,
  description: 'Let the agent do things in the chat',
  version: '1.0.0',
  keywords,
  bundled,
  enabled: false,
  state: {},
  stateSchema: {},
  contributes: {},
  impact: null,
});

describe('npmNameOfSource', () => {
  test('takes the name out of an npm source, with or without a version', () => {
    expect(npmNameOfSource('npm:pi-lens')).toBe('pi-lens');
    expect(npmNameOfSource('npm:pi-lens@1.2.3')).toBe('pi-lens');
    expect(npmNameOfSource('npm:@scope/name')).toBe('@scope/name');
    expect(npmNameOfSource('npm:@scope/name@^2.0.0')).toBe('@scope/name');
  });

  test('has no name for other sources', () => {
    expect(npmNameOfSource('git:github.com/a/b')).toBeUndefined();
    expect(npmNameOfSource('./local')).toBeUndefined();
  });
});

describe('installedByName', () => {
  test('a project package wins over the same name installed globally', () => {
    const global = pkg('npm:pi-lens', { id: 'global' });
    const project = pkg('npm:pi-lens', { id: 'project', scope: 'project' });
    const found = installedByName([
      { config: config([global, pkg('git:github.com/a/b')]), view: 'global' },
      { config: config([global, project]), view: 'project' },
    ]);
    expect(found.get('pi-lens')?.pkg.id).toBe('project');
    expect([...found.keys()]).toEqual(['pi-lens']);
  });

  test('a view still loading adds nothing', () => {
    expect(installedByName([{ config: null, view: 'global' }]).size).toBe(0);
  });
});

describe('compareVersions', () => {
  test('orders numbers, then a prerelease before its release', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });

  test('orders prereleases by semver precedence', () => {
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.beta', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-rc.99999999999999999999', '1.0.0-rc.9')).toBe(1);
  });

  test('treats versions it cannot read as equal', () => {
    expect(compareVersions('latest', '1.0.0')).toBe(0);
  });
});

describe('availableUpdate', () => {
  const latest = { 'pi-lens': '1.3.0' };

  test('offers the newer npm version', () => {
    expect(availableUpdate(pkg('npm:pi-lens', { version: '1.2.0' }), latest)).toBe('1.3.0');
  });

  test('offers nothing when current, pinned, not installed, or unknown', () => {
    expect(availableUpdate(pkg('npm:pi-lens', { version: '1.3.0' }), latest)).toBeUndefined();
    expect(availableUpdate(pkg('npm:pi-lens@1.2.0', { version: '1.2.0', pinned: true }), latest)).toBeUndefined();
    expect(availableUpdate(pkg('npm:pi-lens', { version: '1.2.0', installed: false }), latest)).toBeUndefined();
    expect(availableUpdate(pkg('npm:pi-lens'), latest)).toBeUndefined();
    expect(availableUpdate(pkg('npm:other', { version: '0.1.0' }), latest)).toBeUndefined();
  });
});

describe('matchingPlugins', () => {
  const plugins = [
    plugin('subagents', 'Sub-agents', ['subagent', 'delegate', 'parallel']),
    plugin('visuals', 'Visuals', ['html', 'chart', 'diagram']),
    plugin('third', 'Charts', ['chart'], false),
  ];

  test('matches the start of a name or keyword word', () => {
    expect(matchingPlugins(plugins, 'subagent').map((p) => p.id)).toEqual(['subagents']);
    expect(matchingPlugins(plugins, 'charts and graphs').map((p) => p.id)).toEqual([]);
    expect(matchingPlugins(plugins, 'pi chart').map((p) => p.id)).toEqual(['visuals']);
  });

  test('ignores descriptions, short words, and plugins not shipped with PiChamber', () => {
    expect(matchingPlugins(plugins, 'things in the chat')).toEqual([]);
    expect(matchingPlugins(plugins, 'ui')).toEqual([]);
  });
});

describe('formatCount', () => {
  test('rounds large counts', () => {
    expect(formatCount(950)).toBe('950');
    expect(formatCount(1_200)).toBe('1.2k');
    expect(formatCount(45_600)).toBe('46k');
    expect(formatCount(2_000_000)).toBe('2M');
  });
});

describe('formatInstalledFacts', () => {
  test('names the kind and the version when known', () => {
    expect(formatInstalledFacts(pkg('npm:pi-lens', { version: '1.2.0' }))).toBe('npm package · v1.2.0');
    expect(formatInstalledFacts(pkg('git:github.com/a/b'))).toBe('Git package');
    expect(formatInstalledFacts(pkg('npm:pi-lens@1.2.0', { version: '1.2.0', pinned: true }))).toBe('npm package · v1.2.0 · pinned');
  });
});
