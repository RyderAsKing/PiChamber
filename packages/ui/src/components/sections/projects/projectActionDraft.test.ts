import { describe, expect, test } from 'bun:test';
import {
  getPersistableProjectActions,
  isProjectActionBlank,
  isProjectActionComplete,
  isProjectActionPartial,
} from './projectActionDraft';

const action = (id: string, name: string, command: string) => ({ id, name, command });

describe('projectActionDraft', () => {
  test('classifies complete, blank, and partial drafts', () => {
    expect(isProjectActionComplete(action('a', 'Lint', 'bun run lint'))).toBe(true);
    expect(isProjectActionBlank(action('a', '  ', ''))).toBe(true);
    expect(isProjectActionPartial(action('a', 'Lint', ''))).toBe(true);
    expect(isProjectActionPartial(action('a', '', 'bun run lint'))).toBe(true);
  });

  test('does not persist while a saved action is incomplete', () => {
    const result = getPersistableProjectActions(
      [action('saved', 'Lint', '')],
      new Set(['saved']),
    );
    expect(result.canPersist).toBe(false);
  });

  test('persists complete actions and ignores blank new drafts', () => {
    const result = getPersistableProjectActions(
      [
        action('saved', 'Lint', 'bun run lint'),
        action('draft', '', ''),
      ],
      new Set(['saved']),
    );
    expect(result.canPersist).toBe(true);
    expect(result.actions).toEqual([action('saved', 'Lint', 'bun run lint')]);
  });

  test('includes a new draft once it is complete', () => {
    const result = getPersistableProjectActions(
      [
        action('saved', 'Lint', 'bun run lint'),
        action('draft', 'Test', 'bun test'),
      ],
      new Set(['saved']),
    );
    expect(result.canPersist).toBe(true);
    expect(result.actions.map((entry) => entry.id)).toEqual(['saved', 'draft']);
  });
});
