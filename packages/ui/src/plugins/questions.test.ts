import { describe, expect, test } from 'bun:test';

import { choiceAnswer, MAX_CHOICE_NOTE_CHARS } from '@/components/chat/extensionDialogRespond';
import type { PiExtensionDialogPayload } from '@/lib/pi/protocol';
import { isQuestionDrawn, markQuestionDrawn, sameToolQuestions, selectToolQuestions, toPluginQuestion } from './questions';

const choose = (overrides: Partial<PiExtensionDialogPayload> = {}): PiExtensionDialogPayload => ({
  requestId: 'req-1',
  method: 'choose',
  title: 'Which header?',
  choices: [{ id: 'a', label: 'A: Compact' }, { id: 'b', label: 'B: Tall', description: 'More room' }],
  allowNote: true,
  toolCallId: 'call-1',
  ...overrides,
});

describe('selectToolQuestions', () => {
  test('keeps choose dialogs that name a tool call, in order', () => {
    const first = choose();
    const second = choose({ requestId: 'req-2', toolCallId: 'call-2' });
    const dialogs: PiExtensionDialogPayload[] = [
      { requestId: 'req-select', method: 'select', title: 'Pick', options: ['x'] },
      first,
      choose({ requestId: 'req-loose', toolCallId: undefined }),
      choose({ requestId: 'req-empty', choices: [] }),
      second,
    ];
    expect(selectToolQuestions(dialogs)).toEqual([first, second]);
    expect(selectToolQuestions(undefined)).toEqual([]);
  });
});

describe('sameToolQuestions', () => {
  test('is true for the same dialogs and false when one is added, removed or replaced', () => {
    const first = choose();
    const second = choose({ requestId: 'req-2', toolCallId: 'call-2' });
    expect(sameToolQuestions([first, second], [first, second])).toBe(true);
    expect(sameToolQuestions([], [])).toBe(true);
    expect(sameToolQuestions([first], [first, second])).toBe(false);
    expect(sameToolQuestions([first, second], [second])).toBe(false);
    expect(sameToolQuestions([first], [choose()])).toBe(false);
  });
});

describe('toPluginQuestion', () => {
  test('gives a component the question without its transport fields', () => {
    const question = toPluginQuestion('sess-1', choose({ message: 'Pick the one to build.' }));
    expect(question).toMatchObject({
      requestId: 'req-1',
      title: 'Which header?',
      message: 'Pick the one to build.',
      choices: [{ id: 'a', label: 'A: Compact' }, { id: 'b', label: 'B: Tall', description: 'More room' }],
      allowNote: true,
    });
    expect(typeof question.answer).toBe('function');
    expect(typeof question.dismiss).toBe('function');
  });

  test('a dialog that does not say so takes no note', () => {
    expect(toPluginQuestion('sess-1', choose({ allowNote: undefined })).allowNote).toBe(false);
  });
});

describe('choiceAnswer', () => {
  test('sends a note only when it has text, cut to the server cap', () => {
    expect(choiceAnswer('b')).toEqual({ value: 'b' });
    expect(choiceAnswer('b', '   ')).toEqual({ value: 'b' });
    expect(choiceAnswer('b', '  smaller logo ')).toEqual({ value: 'b', note: 'smaller logo' });
    expect(choiceAnswer('b', 'x'.repeat(MAX_CHOICE_NOTE_CHARS + 50)).note).toHaveLength(MAX_CHOICE_NOTE_CHARS);
  });
});

describe('drawn questions', () => {
  test('a question counts as drawn until every component that draws it is gone', () => {
    expect(isQuestionDrawn('req-drawn')).toBe(false);
    expect(isQuestionDrawn(undefined)).toBe(false);
    const first = markQuestionDrawn('req-drawn');
    const second = markQuestionDrawn('req-drawn');
    expect(isQuestionDrawn('req-drawn')).toBe(true);
    first();
    expect(isQuestionDrawn('req-drawn')).toBe(true);
    second();
    expect(isQuestionDrawn('req-drawn')).toBe(false);
    expect(isQuestionDrawn('req-other')).toBe(false);
  });
});
