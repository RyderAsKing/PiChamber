import { describe, expect, test } from 'bun:test';

import { choiceLetter, choicesFromInput, choicesFromQuestion, choicesInputSize, isChoiceImage, parseChoiceDetails, shownChoice } from './choices';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const details = (extra: Record<string, unknown> = {}) => ({
  title: 'Which header?',
  options: [
    { id: 'a', label: 'Compact', html: '<p>compact</p>' },
    { id: 'b', label: 'Tall', description: 'More room for the logo', image: PNG },
  ],
  ...extra,
});

describe('parseChoiceDetails', () => {
  test('reads the options a call shows, with no answer while it waits', () => {
    expect(parseChoiceDetails(details())).toEqual({
      title: 'Which header?',
      options: [
        { id: 'a', label: 'Compact', html: '<p>compact</p>' },
        { id: 'b', label: 'Tall', description: 'More room for the logo', image: PNG },
      ],
    });
  });

  test('reads the answer and its note', () => {
    expect(parseChoiceDetails(details({ answer: { id: 'b', note: '  smaller logo  ' } }))?.answer).toEqual({ id: 'b', note: 'smaller logo' });
    expect(parseChoiceDetails(details({ answer: { id: 'a' } }))?.answer).toEqual({ id: 'a' });
  });

  test('keeps a closed question apart from one that was never asked', () => {
    expect(parseChoiceDetails(details({ answer: null }))?.answer).toBeNull();
    expect(parseChoiceDetails(details()) && 'answer' in parseChoiceDetails(details())!).toBe(false);
  });

  test('drops an answer that names no option', () => {
    const parsed = parseChoiceDetails(details({ answer: { id: 'z' } }));
    expect(parsed?.options).toHaveLength(2);
    expect(parsed?.answer).toBeUndefined();
  });

  test('rejects details that are not this tool\'s', () => {
    expect(parseChoiceDetails(null)).toBeNull();
    expect(parseChoiceDetails({ title: 'Demo', html: '<p>hi</p>' })).toBeNull();
    expect(parseChoiceDetails({ title: 'x', options: [] })).toBeNull();
    // An option with nothing to show.
    expect(parseChoiceDetails({ title: 'x', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', html: '<p>b</p>' }] })).toBeNull();
    // Two options with one id.
    expect(parseChoiceDetails({ title: 'x', options: [{ id: 'a', label: 'A', html: '1' }, { id: 'a', label: 'B', html: '2' }] })).toBeNull();
  });

  test('only takes images this plugin encodes', () => {
    expect(isChoiceImage(PNG)).toBe(true);
    expect(isChoiceImage('data:image/svg+xml;base64,PHN2Zy8+')).toBe(true);
    expect(isChoiceImage('https://example.com/a.png')).toBe(false);
    expect(isChoiceImage('data:text/html;base64,PGI+')).toBe(false);
    expect(isChoiceImage('javascript:alert(1)')).toBe(false);
    expect(parseChoiceDetails({ title: 'x', options: [
      { id: 'a', label: 'A', image: 'https://example.com/a.png' },
      { id: 'b', label: 'B', html: '<p>b</p>' },
    ] })).toBeNull();
  });

  test('shows at most six options', () => {
    const options = Array.from({ length: 8 }, (_, index) => ({ label: `Option ${index + 1}`, html: '<p>x</p>' }));
    expect(parseChoiceDetails({ title: 'x', options })?.options.map((option) => option.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('choicesFromInput', () => {
  test('letters the options in order and keeps a file as its path', () => {
    expect(choicesFromInput({
      title: 'Which header?',
      options: [
        { label: 'Compact', html: '<p>compact</p>' },
        { label: 'Photo', path: 'mockups/photo.png' },
      ],
    })).toEqual({
      title: 'Which header?',
      options: [
        { id: 'a', label: 'Compact', html: '<p>compact</p>' },
        { id: 'b', label: 'Photo', path: 'mockups/photo.png' },
      ],
    });
  });

  test('never takes an image from the call itself', () => {
    expect(choicesFromInput({ title: 'x', options: [{ label: 'A', image: PNG }, { label: 'B', html: '<p>b</p>' }] })?.options[0]).toEqual({ id: 'a', label: 'A' });
  });

  test('is null until the call has options with labels', () => {
    expect(choicesFromInput(undefined)).toBeNull();
    expect(choicesFromInput({ title: 'x' })).toBeNull();
    expect(choicesFromInput({ title: 'x', options: [{ html: '<p>a</p>' }] })).toBeNull();
  });
});

describe('choicesFromQuestion', () => {
  test('makes an option of every choice, with the letter taken off its label', () => {
    expect(choicesFromQuestion({
      title: 'Which header?',
      choices: [{ id: 'a', label: 'A: Compact' }, { id: 'b', label: 'B: Tall', description: 'More room' }, { id: 'c', label: 'Plain' }],
    })).toEqual({
      title: 'Which header?',
      options: [{ id: 'a', label: 'Compact' }, { id: 'b', label: 'Tall', description: 'More room' }, { id: 'c', label: 'Plain' }],
    });
    expect(choicesFromQuestion({ title: 'x', choices: [] })).toBeNull();
  });
});

describe('choice helpers', () => {
  test('choiceLetter is what the user and the agent both see', () => {
    expect(choiceLetter('b')).toBe('B');
  });

  test('choicesInputSize counts the page text written so far', () => {
    expect(choicesInputSize({ options: [{ html: 'abc' }, { path: 'a.png' }, { html: 'de' }] })).toBe(5);
    expect(choicesInputSize(undefined)).toBe(0);
  });
});

describe('shownChoice', () => {
  const options = [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }, { id: 'c', label: 'Three' }];

  test('starts on the first option', () => {
    expect(shownChoice(options, {}).id).toBe('a');
  });

  test('an answered call opens on the chosen option', () => {
    expect(shownChoice(options, { chosenId: 'c' }).id).toBe('c');
  });

  test('a waiting question opens on the first option it offers', () => {
    expect(shownChoice(options, { offered: ['c', 'b'] }).id).toBe('b');
  });

  test('the option the user switched to wins over both', () => {
    expect(shownChoice(options, { picked: 'a', chosenId: 'c', offered: ['b'] }).id).toBe('a');
  });

  test('an id that is not an option falls through', () => {
    expect(shownChoice(options, { picked: 'z', chosenId: 'y' }).id).toBe('a');
  });
});
