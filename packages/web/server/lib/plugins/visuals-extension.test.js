import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import visuals, { MAX_PAGE_CHARS, renderHtml, TOOL_NAME } from '../../../plugins/visuals/extension.js';
import {
  CHOICES_TOOL_NAME,
  MAX_CHOICES_CHARS,
  askChoice,
  choiceResult,
  renderChoices,
} from '../../../plugins/visuals/choices.js';
import { MAX_IMAGE_BYTES } from '../../../plugins/visuals/files.js';

const project = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-visuals-'));
  const cwd = join(root, 'project');
  await mkdir(join(cwd, 'out'), { recursive: true });
  await writeFile(join(cwd, 'out', 'chart.html'), '<h1>Chart</h1>');
  await writeFile(join(cwd, 'notes.txt'), 'not html');
  await writeFile(join(root, 'secret.html'), '<p>outside</p>');
  return { root, cwd };
};

const fakePi = (activeTools = ['read', 'bash']) => {
  const handlers = new Map();
  const pi = {
    tools: [],
    active: [...activeTools],
    registerTool: (tool) => pi.tools.push(tool),
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => [...pi.active],
    setActiveTools: (names) => { pi.active = [...names]; },
    start: (cwd) => handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, { cwd }),
  };
  return pi;
};

describe('Visuals render_html', () => {
  it('returns a short line and the page in details', async () => {
    await expect(renderHtml({ title: ' Sales ', html: '<p>x</p>', height: 300 })).resolves.toEqual({
      content: [{ type: 'text', text: 'Rendered "Sales".' }],
      details: { title: 'Sales', html: '<p>x</p>', height: 300 },
    });
    await expect(renderHtml({ title: 'No height', html: '<p>x</p>' })).resolves.toMatchObject({ details: { title: 'No height', html: '<p>x</p>' } });
    expect((await renderHtml({ title: 'No height', html: '<p>x</p>' })).details).not.toHaveProperty('height');
  });

  it('reads a page file inside the project and keeps its content in details', async () => {
    const { cwd } = await project();
    await expect(renderHtml({ title: 'Chart', path: 'out/chart.html' }, { cwd })).resolves.toMatchObject({
      details: { title: 'Chart', html: '<h1>Chart</h1>' },
    });
    await expect(renderHtml({ title: 'Chart', path: join(cwd, 'out', 'chart.html') }, { cwd })).resolves.toMatchObject({ details: { html: '<h1>Chart</h1>' } });
  });

  it('keeps file reads inside the project', async () => {
    const { root, cwd } = await project();
    await expect(renderHtml({ title: 't', path: '../secret.html' }, { cwd })).rejects.toThrow(/inside the project/);
    await expect(renderHtml({ title: 't', path: join(root, 'secret.html') }, { cwd })).rejects.toThrow(/inside the project/);
    await symlink(join(root, 'secret.html'), join(cwd, 'link.html'));
    await expect(renderHtml({ title: 't', path: 'link.html' }, { cwd })).rejects.toThrow(/inside the project/);
    await expect(renderHtml({ title: 't', path: 'notes.txt' }, { cwd })).rejects.toThrow(/\.html/);
    await expect(renderHtml({ title: 't', path: 'missing.html' }, { cwd })).rejects.toThrow(/not found/);
    await expect(renderHtml({ title: 't', path: 'out/chart.html' }, {})).rejects.toThrow(/project folder/);
  });

  it('validates the call', async () => {
    await expect(renderHtml({ title: '', html: '<p>' })).rejects.toThrow(/title/);
    await expect(renderHtml({ title: 'x'.repeat(121), html: '<p>' })).rejects.toThrow(/title/);
    await expect(renderHtml({ title: 't' })).rejects.toThrow(/exactly one/);
    await expect(renderHtml({ title: 't', html: '<p>', path: 'a.html' })).rejects.toThrow(/exactly one/);
    await expect(renderHtml({ title: 't', html: '<p>', height: 50 })).rejects.toThrow(/height/);
    await expect(renderHtml({ title: 't', html: '<p>', height: 2001 })).rejects.toThrow(/height/);
    await expect(renderHtml({ title: 't', html: '<p>', height: 300.5 })).rejects.toThrow(/height/);
    await expect(renderHtml({ title: 't', html: '   ' })).rejects.toThrow(/empty/);
  });

  it('caps pages at 512,000 characters', async () => {
    await expect(renderHtml({ title: 't', html: 'x'.repeat(MAX_PAGE_CHARS) })).resolves.toBeTruthy();
    await expect(renderHtml({ title: 't', html: 'x'.repeat(MAX_PAGE_CHARS + 1) })).rejects.toThrow(/512000/);
    const { cwd } = await project();
    await writeFile(join(cwd, 'big.html'), 'x'.repeat(MAX_PAGE_CHARS + 1));
    await expect(renderHtml({ title: 't', path: 'big.html' }, { cwd })).rejects.toThrow(/512000/);
  });
});

describe('Visuals extension', () => {
  it('registers render_html with the short description and no prompt snippet', () => {
    const pi = fakePi();
    visuals(pi);
    expect(pi.tools.map((tool) => tool.name)).toEqual([TOOL_NAME, CHOICES_TOOL_NAME]);
    expect(pi.tools[0]).toMatchObject({ name: TOOL_NAME, parameters: { required: ['title'] } });
    expect(pi.tools[0].description).toMatch(/^Show a finished, self-contained HTML page/);
    expect(pi.tools[0]).not.toHaveProperty('promptSnippet');
  });

  it('adds its tools at session start and keeps the other active tools', () => {
    const pi = fakePi(['read', 'bash']);
    visuals(pi);
    pi.start('/p');
    expect(pi.active).toEqual(['read', 'bash', TOOL_NAME, CHOICES_TOOL_NAME]);
    pi.start('/p');
    expect(pi.active).toEqual(['read', 'bash', TOOL_NAME, CHOICES_TOOL_NAME]);
  });

  it('shows the options, then asks through pichamber.ui.choose with its own tool call id', async () => {
    const pi = fakePi();
    const order = [];
    const asked = [];
    const ctx = { cwd: '/p', ui: {} };
    const pichamber = {
      ui: {
        choose: async (askedCtx, title, choices, opts) => {
          order.push('asked');
          asked.push({ ctx: askedCtx, title, choices, opts });
          return { id: 'b', note: 'darker header' };
        },
      },
    };
    visuals(pi, pichamber);
    const tool = pi.tools.find((entry) => entry.name === CHOICES_TOOL_NAME);
    const signal = new AbortController().signal;
    const result = await tool.execute('call-9', {
      title: 'Which header?',
      options: [
        { label: 'Compact', description: 'One row', html: '<p>a</p>' },
        { label: 'Tall', html: '<p>b</p>' },
      ],
    }, signal, (update) => { order.push('shown'); expect(update.details.options).toHaveLength(2); }, ctx);

    expect(order).toEqual(['shown', 'asked']);
    expect(asked).toEqual([{
      ctx,
      title: 'Which header?',
      choices: [{ id: 'a', label: 'A: Compact', description: 'One row' }, { id: 'b', label: 'B: Tall' }],
      opts: { toolCallId: 'call-9', allowNote: true, signal },
    }]);
    expect(result.content).toEqual([{ type: 'text', text: 'The user chose B: "Tall". Their note: "darker header"' }]);
    expect(result.details).toEqual({
      title: 'Which header?',
      options: [
        { id: 'a', label: 'Compact', description: 'One row', html: '<p>a</p>' },
        { id: 'b', label: 'Tall', html: '<p>b</p>' },
      ],
      answer: { id: 'b', note: 'darker header' },
    });
  });
});

describe('Visuals render_choices', () => {
  const two = [{ label: 'One', html: '<p>1</p>' }, { label: 'Two', html: '<p>2</p>' }];

  it('reads pages and images from the project and letters the options', async () => {
    const { cwd } = await project();
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    await writeFile(join(cwd, 'out', 'shot.png'), png);
    await writeFile(join(cwd, 'out', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const choices = await renderChoices({
      title: ' Which one? ',
      options: [
        { label: ' Chart ', path: 'out/chart.html' },
        { label: 'Shot', description: ' A screenshot ', path: 'out/shot.png' },
        { label: 'Logo', path: 'out/logo.svg' },
      ],
    }, { cwd });
    expect(choices).toEqual({
      title: 'Which one?',
      options: [
        { id: 'a', label: 'Chart', html: '<h1>Chart</h1>' },
        { id: 'b', label: 'Shot', description: 'A screenshot', image: `data:image/png;base64,${png.toString('base64')}` },
        { id: 'c', label: 'Logo', image: expect.stringMatching(/^data:image\/svg\+xml;base64,/) },
      ],
    });
  });

  it('keeps file reads inside the project and to pages and images', async () => {
    const { root, cwd } = await project();
    await symlink(join(root, 'secret.html'), join(cwd, 'out', 'link.html'));
    const withPath = (path) => renderChoices({ title: 'T', options: [{ label: 'One', html: '<p>1</p>' }, { label: 'Two', path }] }, { cwd });
    await expect(withPath('../secret.html')).rejects.toThrow('Option 2: The file must be inside the project folder.');
    await expect(withPath('out/link.html')).rejects.toThrow(/inside the project folder/);
    await expect(withPath('notes.txt')).rejects.toThrow(/must be \.html, \.htm, \.png/);
    await expect(withPath('out/none.png')).rejects.toThrow(/was not found/);
  });

  it('validates the call', async () => {
    await expect(renderChoices({ options: two })).rejects.toThrow('title is required.');
    await expect(renderChoices({ title: 'T', options: [two[0]] })).rejects.toThrow('Give 2 to 6 options.');
    await expect(renderChoices({ title: 'T', options: Array(7).fill(two[0]) })).rejects.toThrow('Give 2 to 6 options.');
    await expect(renderChoices({ title: 'T', options: [two[0], { html: '<p>2</p>' }] })).rejects.toThrow('Option 2 needs a label.');
    await expect(renderChoices({ title: 'T', options: [two[0], { label: 'Two' }] })).rejects.toThrow('Option 2 needs exactly one of html or path.');
    await expect(renderChoices({ title: 'T', options: [two[0], { label: 'Two', html: '<p>2</p>', path: 'a.html' }] })).rejects.toThrow('exactly one of html or path');
    await expect(renderChoices({ title: 'T', options: [two[0], { label: 'Two', html: '   ' }] })).rejects.toThrow("Option 2's page is empty.");
    await expect(renderChoices({ title: 'T', options: [two[0], { label: 'x'.repeat(61), html: '<p>2</p>' }] })).rejects.toThrow(/label is longer/);
  });

  it('caps a page, an image, and the options together', async () => {
    const { cwd } = await project();
    await expect(renderChoices({ title: 'T', options: [two[0], { label: 'Two', html: 'x'.repeat(MAX_PAGE_CHARS + 1) }] }))
      .rejects.toThrow(/Option 2's page is longer/);
    await writeFile(join(cwd, 'out', 'big.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    await expect(renderChoices({ title: 'T', options: [two[0], { label: 'Two', path: 'out/big.png' }] }, { cwd }))
      .rejects.toThrow('Option 2: The image is larger than 750 KB.');
    const page = 'x'.repeat(MAX_PAGE_CHARS);
    const count = Math.floor(MAX_CHOICES_CHARS / MAX_PAGE_CHARS) + 1;
    await expect(renderChoices({ title: 'T', options: Array.from({ length: count }, (_, index) => ({ label: `O${index}`, html: page })) }))
      .rejects.toThrow(/larger than 1500 KB together/);
  });

  it('asks with a plain list in Pi, and says so when it cannot ask', async () => {
    const choices = await renderChoices({ title: 'Which?', options: two });
    const listed = [];
    const withSelect = { hasUI: true, ui: { select: async (title, names) => { listed.push({ title, names }); return 'B: Two'; } } };
    await expect(askChoice(undefined, withSelect, 'call-1', choices)).resolves.toEqual({ asked: true, id: 'b' });
    expect(listed).toEqual([{ title: 'Which?', names: ['A: One', 'B: Two'] }]);
    await expect(askChoice(undefined, { hasUI: true, ui: { select: async () => undefined } }, 'call-1', choices)).resolves.toEqual({ asked: true });
    await expect(askChoice(undefined, { hasUI: false, ui: {} }, 'call-1', choices)).resolves.toEqual({ asked: false });
    // An id the question never offered counts as no answer.
    await expect(askChoice({ ui: { choose: async () => ({ id: 'z' }) } }, {}, 'call-1', choices)).resolves.toEqual({ asked: true });
  });

  it('tells the agent what happened and keeps the answer in details', async () => {
    const choices = await renderChoices({ title: 'Which?', options: two });
    expect(choiceResult(choices, { asked: true, id: 'a' })).toEqual({
      content: [{ type: 'text', text: 'The user chose A: "One".' }],
      details: { ...choices, answer: { id: 'a' } },
    });
    const closed = choiceResult(choices, { asked: true });
    expect(closed.content[0].text).toMatch(/^The user closed the question without choosing\./);
    expect(closed.details).toEqual({ ...choices, answer: null });
    const unasked = choiceResult(choices, { asked: false });
    expect(unasked.content[0].text).toMatch(/cannot ask for a choice/);
    expect(unasked.details).toEqual(choices);
  });
});
