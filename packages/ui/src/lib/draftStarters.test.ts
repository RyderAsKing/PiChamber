import { describe, expect, test } from 'bun:test';

import {
  BUILTIN_TEXT_STARTERS,
  buildPromptWinnerMap,
  dedupeStarterInvocations,
  DEFAULT_GLOBAL_STARTERS,
  normalizeStarterLabel,
  pickPromptWinner,
  sameStarter,
  sanitizeStarterRefs,
  starterKey,
} from './draftStarters';

describe('draftStarters — prompts plus one-time built-in text defaults', () => {
  test('defaults are the five built-in text starters', () => {
    expect(DEFAULT_GLOBAL_STARTERS).toEqual([
      { type: 'text', key: 'explore' },
      { type: 'text', key: 'plan' },
      { type: 'text', key: 'review' },
      { type: 'text', key: 'find-bugs' },
      { type: 'text', key: 'write-tests' },
    ]);
    for (const ref of DEFAULT_GLOBAL_STARTERS) {
      if (ref.type !== 'text') throw new Error('default starter must be text');
      expect(BUILTIN_TEXT_STARTERS[ref.key].text.trim().length).toBeGreaterThan(0);
      expect(BUILTIN_TEXT_STARTERS[ref.key].label.trim().length).toBeGreaterThan(0);
    }
  });

  test('preserves valid prompt starters', () => {
    expect(
      sanitizeStarterRefs([
        { type: 'prompt', name: 'review' },
        { type: 'prompt', name: 'plan-feature', scope: 'project' },
      ]),
    ).toEqual([
      { type: 'prompt', name: 'review' },
      { type: 'prompt', name: 'plan-feature', scope: 'project' },
    ]);
  });

  test('drops legacy skill/command without conversion (same name is not equivalent)', () => {
    expect(
      sanitizeStarterRefs([
        { type: 'skill', name: 'review' },
        { type: 'command', name: 'review' },
        { type: 'prompt', name: 'review' },
        { type: 'text', key: 'review' },
      ]),
    ).toEqual([{ type: 'prompt', name: 'review' }, { type: 'text', key: 'review' }]);
  });

  test('preserves only known built-in text keys', () => {
    expect(
      sanitizeStarterRefs([
        { type: 'text', key: 'explore' },
        { type: 'text', key: 'nope' },
        { type: 'text', name: 'review' },
        { type: 'text', key: 'review' },
        { type: 'text', key: 'review' },
      ]),
    ).toEqual([{ type: 'text', key: 'explore' }, { type: 'text', key: 'review' }]);
  });

  test('drops all retired command starters and never restores them', () => {
    expect(
      sanitizeStarterRefs([
        { type: 'command', name: 'summary' },
        { type: 'command', name: 'craft-goal' },
        { type: 'skill', name: 'code-review' },
      ]),
    ).toEqual([]);
  });

  test('rejects invalid prompt names defensively', () => {
    expect(
      sanitizeStarterRefs([
        { type: 'prompt', name: '  ' },
        { type: 'prompt', name: 'bad name!' },
        { type: 'prompt', name: 'folder/name' },
        { type: 'prompt', name: '' },
        null,
        'review',
      ]),
    ).toEqual([]);
  });

  test('preserves native Pi prompt names derived from dotted filenames', () => {
    expect(sanitizeStarterRefs([{ type: 'prompt', name: 'review.v2' }])).toEqual([
      { type: 'prompt', name: 'review.v2' },
    ]);
  });

  test('dedupes by type:name and is idempotent', () => {
    const input = [
      { type: 'prompt', name: 'review' },
      { type: 'prompt', name: 'review' },
    ];
    const once = sanitizeStarterRefs(input);
    expect(once).toEqual([{ type: 'prompt', name: 'review' }]);
    expect(sanitizeStarterRefs(once)).toEqual(once);
    expect(sanitizeStarterRefs([])).toEqual([]);
    expect(sanitizeStarterRefs(null)).toEqual([]);
  });

  test('starter identity helpers use prompt and text types', () => {
    expect(starterKey({ type: 'prompt', name: 'review' })).toBe('prompt:review');
    expect(starterKey({ type: 'text', key: 'review' })).toBe('text:review');
    expect(
      sameStarter({ type: 'prompt', name: 'review' }, { type: 'prompt', name: 'review' }),
    ).toBe(true);
    expect(
      sameStarter({ type: 'text', key: 'review' }, { type: 'text', key: 'review' }),
    ).toBe(true);
    expect(
      sameStarter({ type: 'prompt', name: 'review' }, { type: 'text', key: 'review' }),
    ).toBe(false);
    expect(normalizeStarterLabel('review-code')).toBe('Review code');
  });

  test('project prompts override globals for starter resolution', () => {
    const winners = buildPromptWinnerMap([
      { name: 'review', location: 'global', editable: true },
      { name: 'review', location: 'project', editable: true },
      { name: 'solo', location: 'global', editable: true },
    ]);
    expect(winners.get('review')?.location).toBe('project');
    expect(winners.get('solo')?.location).toBe('global');
    expect(pickPromptWinner([
      { name: 'x', location: 'package', editable: false },
      { name: 'x', location: 'global', editable: true },
    ])?.location).toBe('global');
  });

  test('never shows two chips with the same invocation (project wins)', () => {
    const project = [{ insertText: '/review ' }];
    const global = [{ insertText: '/review ' }, { insertText: '/plan ' }];
    const deduped = dedupeStarterInvocations(project, global);
    expect(deduped.project).toEqual([{ insertText: '/review ' }]);
    expect(deduped.global).toEqual([{ insertText: '/plan ' }]);
  });
});
