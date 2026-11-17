import { describe, expect, it } from 'vitest';

import {
  describeRuntimeReplacements,
  findReplacedBuiltins,
  findReplacedPlugins,
  findReplacements,
} from './extension-replacements.js';

const extension = (path, { tools = [], commands = [], flags = [], replaceable = false } = {}) => ({
  path,
  resolvedPath: path,
  replaceable,
  tools: new Map(tools.map((name) => [name, {}])),
  commands: new Map(commands.map((name) => [name, {}])),
  flags: new Map(flags.map((name) => [name, {}])),
});

const names = new Map([['subagents', ['tool:subagent', 'command:agents']], ['visuals', ['tool:render_html']]]);

describe('findReplacedPlugins', () => {
  it('reports a plugin a user extension replaced, with the shared name and the winner', () => {
    const loaded = [extension('/agent/extensions/mine.ts', { tools: ['subagent'] })];
    expect(findReplacedPlugins({ loaded, configuredPluginIds: ['subagents'], registeredNames: names })).toEqual([
      { id: 'subagents', registers: { kind: 'tool', name: 'subagent' }, byLoadedPath: '/agent/extensions/mine.ts' },
    ]);
  });

  it('does not report a plugin that is loaded', () => {
    const loaded = [
      extension('<inline:pichamber:subagents>', { tools: ['subagent'], replaceable: true }),
      extension('/agent/extensions/mine.ts', { tools: ['other'] }),
    ];
    expect(findReplacedPlugins({ loaded, configuredPluginIds: ['subagents'], registeredNames: names })).toEqual([]);
  });

  it('does not report a missing plugin when nothing shares a name', () => {
    const loaded = [extension('/agent/extensions/mine.ts', { tools: ['unrelated'] })];
    expect(findReplacedPlugins({ loaded, configuredPluginIds: ['subagents', 'visuals'], registeredNames: names })).toEqual([]);
    expect(findReplacedPlugins({ loaded, configuredPluginIds: ['subagents'], registeredNames: new Map() })).toEqual([]);
  });

  it('never names a replaceable extension as the winner', () => {
    const loaded = [extension('builtin:other', { tools: ['subagent'], replaceable: true })];
    expect(findReplacedPlugins({ loaded, configuredPluginIds: ['subagents'], registeredNames: names })).toEqual([]);
  });

  it('matches by command and flag names, preferring tools first', () => {
    const loaded = [extension('/a/one.ts', { commands: ['agents'] }), extension('/a/two.ts', { tools: ['subagent'] })];
    expect(findReplacedPlugins({ loaded, configuredPluginIds: ['subagents'], registeredNames: names })[0])
      .toMatchObject({ registers: { kind: 'tool', name: 'subagent' }, byLoadedPath: '/a/two.ts' });
    const onlyCommand = [extension('/a/one.ts', { commands: ['agents'] })];
    expect(findReplacedPlugins({ loaded: onlyCommand, configuredPluginIds: ['subagents'], registeredNames: names })[0])
      .toMatchObject({ registers: { kind: 'command', name: 'agents' } });
    const flagNames = new Map([['p', ['flag:plan']]]);
    expect(findReplacedPlugins({ loaded: [extension('/a/f.ts', { flags: ['plan'] })], configuredPluginIds: ['p'], registeredNames: flagNames })[0])
      .toMatchObject({ registers: { kind: 'flag', name: 'plan' } });
  });

  it('tolerates missing input', () => {
    expect(findReplacedPlugins({})).toEqual([]);
  });
});

describe('findReplacedBuiltins', () => {
  const text = (path, kind, shown, name) => `Extension ${path} registers ${kind} \`${shown}\`, so built-in extension \`${name}\` was not loaded. To use \`${name}\`, run \`pi config\`.`;

  it('reads the fact from the warning path and the details from its text', () => {
    const warnings = [
      { path: 'builtin:mcp', warning: text('/agent/extensions/my mcp/index.ts', 'command', '/mcp', 'mcp') },
      { path: 'builtin:codemode', warning: text('/a/b.ts', 'flag', '--code', 'codemode') },
      { path: 'builtin:tool-search', warning: text('/a/c.ts', 'tool', 'tool_search', 'tool-search') },
    ];
    expect(findReplacedBuiltins({ warnings })).toEqual([
      { path: 'builtin:mcp', registers: { kind: 'command', name: 'mcp' }, byPath: '/agent/extensions/my mcp/index.ts' },
      { path: 'builtin:codemode', registers: { kind: 'flag', name: 'code' }, byPath: '/a/b.ts' },
      { path: 'builtin:tool-search', registers: { kind: 'tool', name: 'tool_search' }, byPath: '/a/c.ts' },
    ]);
  });

  it('leaves details out when the text does not match, and ignores other warnings', () => {
    const warnings = [
      { path: 'builtin:mcp', warning: 'something else entirely' },
      { path: 'builtin:codemode', warning: text('/a/b.ts', 'tool', 'x', 'other-name') },
      { path: '/pkg/package.json', warning: 'Host-provided extension packages must be declared in peerDependencies' },
      { path: 'npm:thing', warning: 'failed to install (x)' },
      null,
    ];
    expect(findReplacedBuiltins({ warnings })).toEqual([{ path: 'builtin:mcp' }, { path: 'builtin:codemode' }]);
    expect(findReplacedBuiltins({})).toEqual([]);
  });
});

describe('findReplacements and describeRuntimeReplacements', () => {
  const result = {
    extensions: [{ ...extension('/agent/extensions/mine.ts', { tools: ['subagent'] }), resolvedPath: '/real/mine.ts' }],
    warnings: [{ path: 'builtin:mcp', warning: 'Extension /agent/extensions/mine.ts registers command `/mcp`, so built-in extension `mcp` was not loaded.' }],
  };

  it('returns each winner as its resolved path and a path-free name', () => {
    const out = findReplacements({ extensionsResult: result, configuredPluginIds: ['subagents'], registeredNames: names, nameOf: () => 'mine' });
    expect(out).toEqual({
      plugins: [{ id: 'subagents', registers: { kind: 'tool', name: 'subagent' }, by: { path: '/real/mine.ts', name: 'mine' } }],
      builtins: [{ path: 'builtin:mcp', registers: { kind: 'command', name: 'mcp' }, by: { path: '/real/mine.ts', name: 'mine' } }],
    });
  });

  it('is unknown for a session without a loaded extension result', () => {
    expect(describeRuntimeReplacements({ session: {}, configuredPluginIds: [], registeredNames: new Map() })).toBeUndefined();
    expect(describeRuntimeReplacements({
      session: { resourceLoader: { getExtensions: () => { throw new Error('x'); } } }, configuredPluginIds: [], registeredNames: new Map(),
    })).toBeUndefined();
    const session = { resourceLoader: { getExtensions: () => result } };
    expect(describeRuntimeReplacements({ session, configuredPluginIds: ['subagents'], registeredNames: names }).plugins[0].by.name).toBe('mine');
  });
});
