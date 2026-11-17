// Visuals: `render_choices`. Shows a few variants (pages or images) in the
// chat, one at a time, and waits for the user to pick one. PiChamber draws the
// variants from the call's `details` and asks through `pichamber.ui.choose`, which
// ties the question to this tool call so the chat component can answer it.

import { MAX_PAGE_CHARS, readPageOrImage } from './files.js';

export const CHOICES_TOOL_NAME = 'render_choices';
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_QUESTION_CHARS = 200;
export const MAX_LABEL_CHARS = 60;
export const MAX_DESCRIPTION_CHARS = 240;
/** Every option's page or encoded image together, as kept in the session. */
export const MAX_CHOICES_CHARS = 1_500_000;

const DESCRIPTION = `Show ${MIN_OPTIONS} to ${MAX_OPTIONS} visual variants (layouts, designs, images) in the chat and wait for the user to pick one. The user sees one variant at a time and switches between them. `
  + 'Each option is a self-contained HTML page (html, or path to an .html file) or an image file in the project (path to a .png, .jpg, .webp, .gif or .svg). '
  + 'Pages follow the render_html rules and are shown as wide as the chat (about 720px on desktop, 360px on phones), so let them reflow; the user can expand one to the full window. '
  + 'Returns the option the user chose and any note they added. Use it only when the user should decide between visual alternatives; do not describe the variants again in your reply.';

const PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: MAX_QUESTION_CHARS, description: 'The question, for example "Which header do you prefer?"' },
    options: {
      type: 'array',
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', maxLength: MAX_LABEL_CHARS, description: 'A short name for the variant.' },
          description: { type: 'string', maxLength: MAX_DESCRIPTION_CHARS, description: 'One line on what is different about it.' },
          html: { type: 'string', description: 'The variant as a page. Use this or path.' },
          path: { type: 'string', description: 'An .html or image file in the project instead of html.' },
        },
        required: ['label'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'options'],
  additionalProperties: false,
};

const optionId = (index) => String.fromCharCode(97 + index);
const optionName = (option) => `${option.id.toUpperCase()}: ${option.label}`;

/** Validate the call and load every variant. Exported for tests. */
export const renderChoices = async (params, { cwd } = {}) => {
  const title = typeof params?.title === 'string' ? params.title.trim() : '';
  if (title.length === 0) throw new Error('title is required.');
  if (title.length > MAX_QUESTION_CHARS) throw new Error(`title is longer than ${MAX_QUESTION_CHARS} characters.`);
  const input = params.options;
  if (!Array.isArray(input) || input.length < MIN_OPTIONS || input.length > MAX_OPTIONS) {
    throw new Error(`Give ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`);
  }
  const options = [];
  let total = 0;
  for (const [index, entry] of input.entries()) {
    const number = index + 1;
    const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
    if (label.length === 0) throw new Error(`Option ${number} needs a label.`);
    if (label.length > MAX_LABEL_CHARS) throw new Error(`Option ${number}'s label is longer than ${MAX_LABEL_CHARS} characters.`);
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    if (description.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(`Option ${number}'s description is longer than ${MAX_DESCRIPTION_CHARS} characters.`);
    }
    const hasHtml = entry.html !== undefined;
    const hasPath = entry.path !== undefined;
    if (hasHtml === hasPath) throw new Error(`Option ${number} needs exactly one of html or path.`);
    if (hasHtml && typeof entry.html !== 'string') throw new Error(`Option ${number}'s html must be a string.`);
    let content;
    try {
      content = hasHtml ? { html: entry.html } : await readPageOrImage(cwd, entry.path);
    } catch (error) {
      throw new Error(`Option ${number}: ${error?.message ?? 'the file could not be read.'}`);
    }
    if (content.html !== undefined) {
      if (content.html.trim().length === 0) throw new Error(`Option ${number}'s page is empty.`);
      if (content.html.length > MAX_PAGE_CHARS) throw new Error(`Option ${number}'s page is longer than ${MAX_PAGE_CHARS} characters.`);
    }
    total += (content.html ?? content.image).length;
    if (total > MAX_CHOICES_CHARS) {
      throw new Error(`The options are larger than ${Math.round(MAX_CHOICES_CHARS / 1000)} KB together. Use smaller pages or images, or fewer options.`);
    }
    options.push({ id: optionId(index), label, ...(description ? { description } : {}), ...content });
  }
  return { title, options };
};

/**
 * Ask which variant the user wants. Resolves `{ asked: false }` when the
 * client has no way to ask, else `{ asked: true, id?, note? }` with no `id`
 * when the question was closed without an answer.
 */
export const askChoice = async (pichamber, ctx, toolCallId, choices, signal) => {
  const ui = ctx?.ui;
  if (typeof pichamber?.ui?.choose === 'function') {
    const answer = await pichamber.ui.choose(
      ctx,
      choices.title,
      choices.options.map((option) => ({
        id: option.id,
        label: optionName(option),
        ...(option.description ? { description: option.description } : {}),
      })),
      { toolCallId, allowNote: true, signal },
    );
    const chosen = choices.options.find((option) => option.id === answer?.id);
    if (!chosen) return { asked: true };
    return { asked: true, id: chosen.id, ...(typeof answer.note === 'string' && answer.note ? { note: answer.note } : {}) };
  }
  // Plain Pi: a text list of the labels. The variants are not drawn there.
  if (ctx?.hasUI && typeof ui?.select === 'function') {
    const names = choices.options.map(optionName);
    const picked = await ui.select(choices.title, names, { signal });
    const index = names.indexOf(picked);
    return index < 0 ? { asked: true } : { asked: true, id: choices.options[index].id };
  }
  return { asked: false };
};

/** The tool result for an answer from `askChoice`. Exported for tests. */
export const choiceResult = (choices, answer) => {
  if (!answer.asked) {
    return {
      content: [{ type: 'text', text: `Showed ${choices.options.length} options for "${choices.title}", but this client cannot ask for a choice. Ask the user which one they want in your reply.` }],
      details: { ...choices },
    };
  }
  const chosen = choices.options.find((option) => option.id === answer.id);
  if (!chosen) {
    return {
      content: [{ type: 'text', text: 'The user closed the question without choosing. The options stay visible in the chat. Do not show them again; wait for what the user says next.' }],
      details: { ...choices, answer: null },
    };
  }
  const note = answer.note ? ` Their note: ${JSON.stringify(answer.note)}` : '';
  return {
    content: [{ type: 'text', text: `The user chose ${chosen.id.toUpperCase()}: ${JSON.stringify(chosen.label)}.${note}` }],
    details: { ...choices, answer: { id: chosen.id, ...(answer.note ? { note: answer.note } : {}) } },
  };
};

/**
 * Register `render_choices`. `getCwd` gives the session's folder when the
 * call has none. `pichamber` is PiChamber's handle; plain Pi passes none.
 */
export const registerChoicesTool = (pi, getCwd, pichamber) => {
  pi.registerTool({
    name: CHOICES_TOOL_NAME,
    label: 'Render choices',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const choices = await renderChoices(params, { cwd: ctx?.cwd ?? getCwd() });
      // The variants reach the chat before the question, so the user sees
      // what they are choosing between while the call waits.
      onUpdate?.({ content: [{ type: 'text', text: 'Waiting for the user to choose.' }], details: { ...choices } });
      // Pi delivers that update after this turn of the event loop. Asking
      // only then keeps the question from arriving before its variants.
      await new Promise((resolve) => setImmediate(resolve));
      return choiceResult(choices, await askChoice(pichamber, ctx, toolCallId, choices, signal));
    },
  });
};
