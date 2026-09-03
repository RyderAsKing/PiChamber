import { describe, expect, test } from 'bun:test';
import {
  commandMatchesCategory,
  commandMatchesSearch,
  mergeCommandAutocompleteItems,
} from '../commandAutocompleteItems';

interface Item {
  name: string;
  source: 'pichamber' | 'pi' | 'skill' | 'extension' | 'prompt';
  description?: string;
  searchAliases?: string[];
  isBuiltIn?: boolean;
  isSkill?: boolean;
}

describe('commandMatchesCategory', () => {
  const items: Item[] = [
    { name: 'compact', source: 'pichamber', isBuiltIn: true },
    { name: 'review', source: 'skill', isSkill: true },
    { name: 'deploy', source: 'extension' },
    { name: 'format', source: 'pi' },
  ];

  test('filters by source while keeping all as the default view', () => {
    expect(items.filter((item) => commandMatchesCategory(item, 'all')).map((item) => item.name))
      .toEqual(['compact', 'review', 'deploy', 'format']);
    expect(items.filter((item) => commandMatchesCategory(item, 'system')).map((item) => item.name))
      .toEqual(['compact']);
    expect(items.filter((item) => commandMatchesCategory(item, 'skills')).map((item) => item.name))
      .toEqual(['review']);
    expect(items.filter((item) => commandMatchesCategory(item, 'extensions')).map((item) => item.name))
      .toEqual(['deploy']);
    expect(items.filter((item) => commandMatchesCategory(item, 'prompts')).map((item) => item.name))
      .toEqual([]);
    expect(commandMatchesCategory({ name: 'review', source: 'prompt' }, 'prompts')).toBe(true);
  });

  test('uses built-in and skill metadata when source labels are not specific', () => {
    expect(commandMatchesCategory({ name: 'local', isBuiltIn: true }, 'system')).toBe(true);
    expect(commandMatchesCategory({ name: 'workflow', isSkill: true }, 'skills')).toBe(true);
    expect(commandMatchesCategory({ name: 'local', isBuiltIn: true, source: 'pi' }, 'system')).toBe(true);
    expect(commandMatchesCategory({ name: 'workflow', isSkill: true, source: 'pi' }, 'skills')).toBe(true);
  });
});

describe('mergeCommandAutocompleteItems', () => {
  test('retains the discovered skill and command search metadata for #1550', () => {
    const commands: Item[] = [{
      name: 'grill-with-docs',
      source: 'pi',
      description: 'Plugin command description',
      isSkill: true,
    }];
    const skills: Item[] = [{
      name: 'grill-with-docs',
      source: 'skill',
      description: 'Canonical skill description',
      isSkill: true,
    }];

    const merged = mergeCommandAutocompleteItems([], commands, skills);

    expect(merged).toEqual([{
      ...skills[0],
      searchAliases: ['Plugin command description'],
    }]);
    expect(commandMatchesSearch(merged[0], 'plugin command')).toBe(true);
  });

  test('built-ins win collisions with commands and skills without losing search aliases', () => {
    const builtIn: Item = {
      name: 'digest',
      source: 'pichamber',
      description: 'Summarize this session',
      isBuiltIn: true,
    };
    const command: Item = {
      name: 'digest',
      source: 'pi',
      description: 'Plugin session digest',
    };
    const skill: Item = {
      name: 'digest',
      source: 'skill',
      description: 'Skill session recap',
      isSkill: true,
    };

    expect(mergeCommandAutocompleteItems([builtIn], [command], [skill])).toEqual([{
      ...builtIn,
      searchAliases: ['Plugin session digest', 'Skill session recap'],
    }]);
  });

  test('Pi built-ins also win collisions with discovered skills', () => {
    const builtIn: Item = {
      name: 'review',
      source: 'pi',
      description: 'Review workspace changes',
      isBuiltIn: true,
    };
    const skill: Item = {
      name: 'review',
      source: 'skill',
      description: 'Review skill',
      isSkill: true,
    };

    expect(mergeCommandAutocompleteItems([], [builtIn], [skill])).toEqual([{
      ...builtIn,
      searchAliases: ['Review skill'],
    }]);
  });

  test('deduplicates every pairwise source collision by executable precedence', () => {
    const builtIn: Item = { name: 'compact', source: 'pichamber', isBuiltIn: true };
    const command: Item = { name: 'compact', source: 'pi' };
    const skill: Item = { name: 'compact', source: 'skill', isSkill: true };

    expect(mergeCommandAutocompleteItems([builtIn], [command], [])[0]).toBe(builtIn);
    expect(mergeCommandAutocompleteItems([builtIn], [], [skill])[0]).toBe(builtIn);
    expect(mergeCommandAutocompleteItems([], [command], [skill])[0]).toBe(skill);
  });

  test('Pi skill-commands win custom commands and yield to discovered skills', () => {
    const command: Item = { name: 'deploy', source: 'pi', description: 'Custom deploy' };
    const skillCommand: Item = {
      name: 'deploy',
      source: 'pi',
      description: 'Pi skill command',
      isSkill: true,
    };
    const skill: Item = {
      name: 'deploy',
      source: 'skill',
      description: 'Discovered deploy skill',
      isSkill: true,
    };

    expect(mergeCommandAutocompleteItems([], [command, skillCommand], [])).toEqual([{
      ...skillCommand,
      searchAliases: ['Custom deploy'],
    }]);
    expect(mergeCommandAutocompleteItems([], [command, skillCommand], [skill])).toEqual([{
      ...skill,
      searchAliases: ['Pi skill command', 'Custom deploy'],
    }]);
  });

  test('keeps a case-distinct command when the built-in is disabled', () => {
    const builtIn: Item = { name: 'init', source: 'pichamber', isBuiltIn: true };
    const command: Item = { name: 'Init', source: 'pi', description: 'Custom init' };
    const merged = mergeCommandAutocompleteItems([builtIn], [command], []);

    expect(merged).toEqual([builtIn, command]);
    expect(merged.filter((item) => item.name !== 'init')).toEqual([command]);
  });

  test('keeps first-seen ordering and unrelated commands', () => {
    const builtIns: Item[] = [{ name: 'undo', source: 'pichamber' }];
    const commands: Item[] = [
      { name: 'test', source: 'pi' },
      { name: 'deploy', source: 'pi' },
    ];
    const skills: Item[] = [
      { name: 'deploy', source: 'skill', isSkill: true },
      { name: 'explain', source: 'skill', isSkill: true },
    ];

    const merged = mergeCommandAutocompleteItems(builtIns, commands, skills);

    expect(merged.map((item) => item.name)).toEqual(['undo', 'test', 'deploy', 'explain']);
    expect(merged[2]).toBe(skills[0]);
  });

  test('deduplicates repeated entries within each source without mutating inputs', () => {
    const first: Item = { name: 'test', source: 'pi', description: 'First' };
    const duplicate: Item = { name: 'test', source: 'pi', description: 'Second' };

    expect(mergeCommandAutocompleteItems([], [first, duplicate], [])).toEqual([{
      ...first,
      searchAliases: ['Second'],
    }]);
    expect(first.searchAliases).toBe(undefined);
  });

  test('handles empty inputs', () => {
    expect(mergeCommandAutocompleteItems([], [], [])).toEqual([]);
  });

  test('Pi prompt templates lose to skills but win plain custom commands', () => {
    const command: Item = { name: 'review', source: 'pi', description: 'Custom' };
    const prompt: Item = { name: 'review', source: 'prompt', description: 'Pi template' };
    const skill: Item = { name: 'review', source: 'skill', description: 'Skill', isSkill: true };

    expect(mergeCommandAutocompleteItems([], [command], [], [prompt])[0]).toEqual({
      ...prompt,
      searchAliases: ['Custom'],
    });
    expect(mergeCommandAutocompleteItems([], [], [skill], [prompt])[0]).toEqual({
      ...skill,
      searchAliases: ['Pi template'],
    });
  });

  test('extension commands win collisions with prompts and skills', () => {
    const extension: Item = { name: 'review', source: 'extension', description: 'Extension' };
    const prompt: Item = { name: 'review', source: 'prompt', description: 'Pi template' };
    const skill: Item = { name: 'review', source: 'skill', description: 'Skill', isSkill: true };

    expect(mergeCommandAutocompleteItems([], [extension], [skill], [prompt])[0]).toEqual({
      ...extension,
      searchAliases: ['Skill', 'Pi template'],
    });
  });
});
