import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ToolPart } from '@/lib/chat/types';
import type { PluginQuestion } from '@/plugins/types';
import ChoicesArtifact from './ChoicesArtifact';

// Image options only: a page option needs a document and the theme to build
// its frame, which a static render has neither of.
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const options = [
  { id: 'a', label: 'Compact', image: PNG },
  { id: 'b', label: 'Tall', description: 'More room for the logo', image: PNG },
];

const part = (state: Record<string, unknown>): ToolPart => ({
  id: 'part-1',
  type: 'tool',
  tool: 'render_choices',
  callID: 'call-1',
  state: state as ToolPart['state'],
});

const question = (overrides: Partial<PluginQuestion> = {}): PluginQuestion => ({
  requestId: 'req-1',
  title: 'Which header?',
  choices: [{ id: 'a', label: 'A: Compact' }, { id: 'b', label: 'B: Tall' }],
  allowNote: true,
  answer: async () => {},
  dismiss: async () => {},
  ...overrides,
});

const render = (toolPart: ToolPart, pending?: PluginQuestion) => renderToStaticMarkup(
  <ChoicesArtifact part={toolPart} directory="/repo" question={pending} />,
);

describe('ChoicesArtifact', () => {
  test('a waiting call shows the first option, a switcher, a note and Skip', () => {
    const markup = render(part({ status: 'running', metadata: { title: 'Which header?', options } }), question());
    expect(markup).toContain('data-plugin-artifact="visuals-choices"');
    expect(markup).toContain('Which header?');
    expect(markup).toContain('Waiting for your choice');
    // One variant at a time: A is in the frame, B is a press away.
    expect(markup).toContain('>Choose A<');
    expect(markup).not.toContain('>Choose B<');
    expect(/aria-pressed="true"[^>]*data-choice-tab="a"/.test(markup)).toBe(true);
    expect(/aria-pressed="false"[^>]*data-choice-tab="b"/.test(markup)).toBe(true);
    expect(markup).toContain('>Tall<');
    expect(markup.match(/data-choice-panel=/g)?.length).toBe(2);
    expect(markup).toContain(`src="${PNG}"`);
    expect(markup).toContain('placeholder="Add a note for the agent (optional)"');
    expect(markup).toContain('>Skip<');
    expect(markup).not.toContain('data-chosen');
  });

  test('a question that offers one option opens on it', () => {
    const markup = render(
      part({ status: 'running', metadata: { title: 'Which header?', options } }),
      question({ choices: [{ id: 'b', label: 'B: Tall' }], allowNote: false }),
    );
    expect(markup).not.toContain('>Choose A<');
    expect(markup).toContain('>Choose B<');
    expect(markup).toContain('More room for the logo');
    expect(markup).not.toContain('Add a note');
  });

  test('a waiting call without its details draws from the input, files by path', () => {
    const markup = render(part({
      status: 'running',
      input: { title: 'Which header?', options: [{ label: 'Compact', path: 'mockups/compact.png' }, { label: 'Photo', path: 'mockups/photo.png' }] },
    }), question());
    expect(markup).toContain('>Choose A<');
    expect(markup).toContain('Preview not loaded');
    expect(markup).toContain('mockups/photo.png');
  });

  test('a waiting call with nothing readable still offers the question\'s choices', () => {
    const markup = render(part({ status: 'running' }), question());
    expect(markup).toContain('>Choose A<');
    expect(markup).toContain('>Compact<');
    expect(markup).toContain('>Tall<');
    expect(markup).toContain('Preview not loaded');
  });

  test('a running call with no question yet shows its options without buttons', () => {
    const markup = render(part({ status: 'running', metadata: { title: 'Which header?', options } }));
    expect(markup).toContain('Compact');
    expect(markup).not.toContain('>Choose A<');
    expect(markup).not.toContain('>Skip<');
    expect(markup).not.toContain('Waiting for your choice');
  });

  test('a call still being written shows the placeholder', () => {
    const markup = render(part({ status: 'pending', input: { title: 'Which header?', options: [{ label: 'Compact', html: '<p>co' }] } }));
    expect(markup).toContain('Drawing options');
    expect(markup).not.toContain('visuals-choices');
  });

  test('an answered call opens on the chosen option, marks it and shows the note', () => {
    const markup = render(part({
      status: 'completed',
      metadata: { title: 'Which header?', options, answer: { id: 'b', note: 'smaller logo' } },
    }));
    expect(markup).toContain('You chose B');
    expect(markup.match(/data-chosen="true"/g)?.length).toBe(1);
    expect(/aria-pressed="true"[^>]*data-choice-tab="b" data-chosen="true"/.test(markup)).toBe(true);
    expect(markup).toContain('More room for the logo');
    expect(markup).toContain('Your note: ');
    expect(markup).toContain('smaller logo');
    expect(markup).not.toContain('>Choose A<');
    expect(markup).not.toContain('>Skip<');
  });

  test('a finished call ignores a stale question', () => {
    const markup = render(part({ status: 'completed', metadata: { title: 'Which header?', options, answer: null } }), question());
    expect(markup).toContain('No choice made');
    expect(markup).not.toContain('>Choose A<');
  });

  test('a failed call or details of another shape draw nothing', () => {
    expect(render(part({ status: 'error', metadata: { title: 'Which header?', options } }))).toBe('');
    expect(render(part({ status: 'completed', metadata: { title: 'Demo', html: '<p>hi</p>' } }))).toBe('');
  });
});
