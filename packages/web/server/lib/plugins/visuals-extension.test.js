import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import visuals, { MAX_PAGE_CHARS, renderHtml, TOOL_NAME } from '../../../plugins/visuals/extension.js';

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
    expect(pi.tools).toHaveLength(1);
    expect(pi.tools[0]).toMatchObject({ name: TOOL_NAME, parameters: { required: ['title'] } });
    expect(pi.tools[0].description).toMatch(/^Show a finished, self-contained HTML page/);
    expect(pi.tools[0]).not.toHaveProperty('promptSnippet');
  });

  it('adds its tool at session start and keeps the other active tools', () => {
    const pi = fakePi(['read', 'bash']);
    visuals(pi);
    pi.start('/p');
    expect(pi.active).toEqual(['read', 'bash', TOOL_NAME]);
    pi.start('/p');
    expect(pi.active).toEqual(['read', 'bash', TOOL_NAME]);
  });
});
