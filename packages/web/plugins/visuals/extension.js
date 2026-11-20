// Visuals: the agent half. Registers `render_html`, which shows a finished
// HTML page in the chat, and `render_choices` (choices.js), which shows a
// few variants and waits for the user to pick one. PiChamber draws both from
// the result's `details`; this module only validates and returns them.
//
// It has no switch of its own: while the plugin is on in Settings, the tools
// are there in every session. `render_choices` asks through
// `globalThis.pichamber.choose`; plain Pi has none and gets a text list.

import { CHOICES_TOOL_NAME, registerChoicesTool } from './choices.js';
import { MAX_PAGE_CHARS, readPage } from './files.js';

export { MAX_PAGE_CHARS };
export const TOOL_NAME = 'render_html';
export const TOOL_NAMES = [TOOL_NAME, CHOICES_TOOL_NAME];
export const MAX_TITLE_CHARS = 120;
export const MIN_HEIGHT = 120;
export const MAX_HEIGHT = 2_000;

const DESCRIPTION = 'Show a finished, self-contained HTML page (chart, diagram, table, mockup) in the chat above your reply. '
  + 'Inline all CSS and JS; no network. It sits in the reply column (~760px, ~360px on phones) on the chat background, so use fluid widths. '
  + 'No outer card, border, background, side padding or title heading; boxes get 12-16px padding and var(--pc-radius). '
  + 'The frame fits the content: charts get a fixed px height; no vh or 100%. Text, tables, inputs, code and SVG text are pre-styled. '
  + 'Labels and axes 12px in --pc-muted, headings ≤16px, big numbers ≤24px. '
  + 'Colours: --pc-bg, --pc-surface, --pc-fg, --pc-muted, --pc-border, --pc-accent. One series = --pc-c1; '
  + 'ranked values: its shades --pc-shade-1..4; --pc-c2..5 only for more series, max 3 in all; '
  + '--pc-good/--pc-warn/--pc-bad only for status. '
  + "Do not repeat the page's content in your reply.";

const PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: MAX_TITLE_CHARS },
    html: { type: 'string', description: 'The page. Use this or path.' },
    path: { type: 'string', description: 'An .html file in the project instead of html.' },
    height: { type: 'integer', minimum: MIN_HEIGHT, maximum: MAX_HEIGHT, description: 'Pixels to hold until the page loads.' },
  },
  required: ['title'],
  additionalProperties: false,
};

/** Validate the call and produce the page. Exported for tests. */
export const renderHtml = async (params, { cwd } = {}) => {
  const title = typeof params?.title === 'string' ? params.title.trim() : '';
  if (title.length === 0) throw new Error('title is required.');
  if (title.length > MAX_TITLE_CHARS) throw new Error(`title is longer than ${MAX_TITLE_CHARS} characters.`);
  const hasHtml = params.html !== undefined;
  const hasPath = params.path !== undefined;
  if (hasHtml === hasPath) throw new Error('Give exactly one of html or path.');
  if (hasHtml && typeof params.html !== 'string') throw new Error('html must be a string.');
  const height = params.height;
  if (height !== undefined && (!Number.isInteger(height) || height < MIN_HEIGHT || height > MAX_HEIGHT)) {
    throw new Error(`height must be a whole number from ${MIN_HEIGHT} to ${MAX_HEIGHT}.`);
  }
  const html = hasHtml ? params.html : await readPage(cwd, params.path);
  if (html.trim().length === 0) throw new Error('The page is empty.');
  if (html.length > MAX_PAGE_CHARS) throw new Error(`The page is longer than ${MAX_PAGE_CHARS} characters.`);
  return {
    content: [{ type: 'text', text: `Rendered "${title}".` }],
    details: { title, html, ...(height !== undefined ? { height } : {}) },
  };
};

export default function visuals(pi) {
  let cwd;

  pi.registerTool({
    name: TOOL_NAME,
    label: 'Render HTML',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return renderHtml(params, { cwd: ctx?.cwd ?? cwd });
    },
  });

  registerChoicesTool(pi, () => cwd);

  // Keep the rest of the active tools as they are; only add ours.
  pi.on('session_start', (_event, ctx) => {
    cwd = ctx?.cwd;
    try {
      const active = pi.getActiveTools();
      const missing = TOOL_NAMES.filter((name) => !active.includes(name));
      if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
    } catch {
      // A runtime that is shutting down has no tools to change.
    }
  });
}
