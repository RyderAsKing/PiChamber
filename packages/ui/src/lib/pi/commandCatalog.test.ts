import { describe, expect, test } from 'bun:test';

import {
  buildSystemCatalogCommands,
  catalogInvocationSet,
  getCommandCatalogInvalidationRevision,
  invalidateCommandCatalogCache,
  subscribeCommandCatalogInvalidation,
  toCatalogCommands,
} from './commandCatalog';

describe('commandCatalog — executable invocation identity', () => {
  test('system commands expose bare invocations', () => {
    const system = buildSystemCatalogCommands();
    const byName = new Map(system.map((c) => [c.name, c]));
    for (const name of ['undo', 'redo', 'timeline', 'compact']) {
      const command = byName.get(name);
      expect(command).toBeDefined();
      expect(command?.invocationName).toBe(name);
      expect(command?.source).toBe('system');
    }
    // Supported system commands only: no TUI-only /reload, /model, /settings,
    // and no browser-unhandled /init.
    expect(byName.has('init')).toBe(false);
    expect(byName.has('reload')).toBe(false);
    expect(byName.has('model')).toBe(false);
    expect(byName.has('settings')).toBe(false);
  });

  test('prompt templates use /name', () => {
    const [command] = toCatalogCommands([
      { name: 'review', description: 'Review', source: 'prompt', scope: 'global' },
    ]);
    expect(command.name).toBe('review');
    expect(command.invocationName).toBe('review');
    expect(command.source).toBe('prompt');
  });

  test('skills use /skill:name, never bare /name', () => {
    const [command] = toCatalogCommands([
      { name: 'skill:code-review', description: 'Review', source: 'skill', scope: 'global' },
    ]);
    expect(command.name).toBe('code-review');
    expect(command.invocationName).toBe('skill:code-review');
    expect(command.source).toBe('skill');
  });

  test('bare skill names from older payloads are normalized to skill: prefix', () => {
    const [command] = toCatalogCommands([
      // Defensive: server always sends skill:xxx, but never emit bare.
      { name: 'code-review', description: 'Review', source: 'skill' } as never,
    ]);
    expect(command.invocationName).toBe('skill:code-review');
  });

  test('extension commands keep their registered invocation including suffixes', () => {
    const [first, second] = toCatalogCommands([
      { name: 'hello', description: 'Hi', source: 'extension' },
      { name: 'hello:2', description: 'Hi again', source: 'extension' },
    ]);
    expect(first.invocationName).toBe('hello');
    expect(second.invocationName).toBe('hello:2');
  });

  test('catalog ids stay stable when command order changes', () => {
    const commands = [
      { name: 'review', source: 'prompt' as const, scope: 'global' },
      { name: 'skill:code-review', source: 'skill' as const, scope: 'global' },
    ];
    const forward = new Map(toCatalogCommands(commands).map((command) => [command.invocationName, command.id]));
    const reversed = new Map(toCatalogCommands([...commands].reverse()).map((command) => [command.invocationName, command.id]));
    expect(reversed).toEqual(forward);
  });

  test('cache invalidation publishes a revision for mounted catalog hooks', () => {
    const before = getCommandCatalogInvalidationRevision();
    let notifications = 0;
    const unsubscribe = subscribeCommandCatalogInvalidation(() => {
      notifications += 1;
    });
    invalidateCommandCatalogCache('/work');
    unsubscribe();
    expect(getCommandCatalogInvalidationRevision()).toBe(before + 1);
    expect(notifications).toBe(1);
  });

  test('skill names with dashes and underscores survive', () => {
    const [dash, underscore] = toCatalogCommands([
      { name: 'skill:code-review', source: 'skill' },
      { name: 'skill:my_skill', source: 'skill' },
    ]);
    expect(dash.invocationName).toBe('skill:code-review');
    expect(underscore.invocationName).toBe('skill:my_skill');
  });

  test('invocation set drives tokenizer membership (bare skill never matches)', () => {
    const catalog = [
      ...buildSystemCatalogCommands(),
      ...toCatalogCommands([
        { name: 'review', source: 'prompt' },
        { name: 'skill:code-review', source: 'skill' },
        { name: 'hello', source: 'extension' },
      ]),
    ];
    const known = catalogInvocationSet(catalog);
    expect(known.has('review')).toBe(true);
    expect(known.has('skill:code-review')).toBe(true);
    expect(known.has('hello')).toBe(true);
    expect(known.has('undo')).toBe(true);
    expect(known.has('code-review')).toBe(false);
  });
});
