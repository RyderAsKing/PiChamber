// Visuals: the agent half. Registers `render_html`, which shows a finished
// HTML page in the chat. PiChamber draws the page from the result's
// `details`; this module only validates and returns it.
//
// It has no switch of its own: while the plugin is on in Settings, the tool
// is there in every session. PiChamber's `chamber` handle is not needed.

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export const TOOL_NAME = 'render_html';
export const MAX_PAGE_CHARS = 512_000;
export const MAX_TITLE_CHARS = 120;
export const MIN_HEIGHT = 120;
export const MAX_HEIGHT = 2_000;
const PAGE_EXTENSIONS = new Set(['.html', '.htm']);

const DESCRIPTION = 'Show a finished, self-contained HTML page (chart, diagram, table, mockup) in the chat above your reply. '
  + 'Inline all CSS and JS; network requests are blocked. About 760px wide, narrower on phones, so let it reflow. '
  + 'Body, headings, tables, buttons, inputs and code are already styled; add only layout and specifics. '
  + 'Colour with the theme variables --pc-bg, --pc-surface, --pc-fg, --pc-muted, --pc-border, --pc-accent, '
  + '--pc-c1 to --pc-c5 (data series), --pc-good, --pc-warn and --pc-bad so it matches light and dark mode. '
  + "Do not repeat the page's content in your reply.";

const PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: MAX_TITLE_CHARS },
    html: { type: 'string', description: 'The page. Use this or path.' },
    path: { type: 'string', description: 'An .html file in the project instead of html.' },
    height: { type: 'integer', minimum: MIN_HEIGHT, maximum: MAX_HEIGHT, description: 'Frame height in pixels.' },
  },
  required: ['title'],
  additionalProperties: false,
};

const isInside = (root, target) => {
  const fromRoot = relative(root, target);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
};

const readPage = async (cwd, path) => {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('No project folder to read the page from.');
  if (typeof path !== 'string' || path.trim().length === 0) throw new Error('path is empty.');
  let root;
  let file;
  try {
    root = await realpath(cwd);
    file = await realpath(resolve(root, path.trim()));
  } catch {
    throw new Error('The page file was not found.');
  }
  if (!isInside(root, file)) throw new Error('The page file must be inside the project folder.');
  if (!PAGE_EXTENSIONS.has(extname(file).toLowerCase())) throw new Error('The page file must be .html or .htm.');
  const info = await stat(file);
  if (!info.isFile()) throw new Error('The page path is not a file.');
  // A UTF-8 character is at most 4 bytes; skip reading what cannot fit.
  if (info.size > MAX_PAGE_CHARS * 4) throw new Error(`The page is longer than ${MAX_PAGE_CHARS} characters.`);
  return readFile(file, 'utf8');
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

  // Keep the rest of the active tools as they are; only add ours.
  pi.on('session_start', (_event, ctx) => {
    cwd = ctx?.cwd;
    try {
      const active = pi.getActiveTools();
      if (!active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
    } catch {
      // A runtime that is shutting down has no tools to change.
    }
  });
}
