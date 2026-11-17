/** `render_choices` details: the variants a call shows and what the user picked. */

export interface ChoiceOption {
  /** `a`, `b`, ... in the order the agent gave them. */
  id: string;
  label: string;
  description?: string;
  /** The variant as a page. */
  html?: string;
  /** The variant as an image, a `data:` URL. */
  image?: string;
  /** A file the agent named whose content this client has not been sent. */
  path?: string;
}

export interface ChoiceDetails {
  title: string;
  options: ChoiceOption[];
  /**
   * The answer: the chosen option; `null` when the question was closed
   * without one; absent while it waits or when nothing was asked.
   */
  answer?: { id: string; note?: string } | null;
}

const MAX_OPTIONS = 6;
const IMAGE_PREFIX = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,/;

/** True for an image this plugin's agent half encodes, safe as an `<img>` source. */
export const isChoiceImage = (value: unknown): value is string => (
  typeof value === 'string' && IMAGE_PREFIX.test(value)
);

/** `A` for `a`: what the user sees and what the agent is told. */
export const choiceLetter = (id: string): string => id.toUpperCase();

const optionId = (index: number): string => String.fromCharCode(97 + index);

const readOption = (value: unknown, index: number): ChoiceOption | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  if (!label) return null;
  const id = typeof record.id === 'string' && /^[a-z]$/.test(record.id) ? record.id : optionId(index);
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(typeof record.html === 'string' && record.html.length > 0 ? { html: record.html } : {}),
    ...(isChoiceImage(record.image) ? { image: record.image } : {}),
    ...(typeof record.path === 'string' && record.path.trim() ? { path: record.path.trim() } : {}),
  };
};

const readOptions = (value: unknown): ChoiceOption[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.slice(0, MAX_OPTIONS).entries()) {
    const option = readOption(entry, index);
    if (!option || seen.has(option.id)) return null;
    seen.add(option.id);
    options.push(option);
  }
  return options;
};

const readTitle = (value: unknown): string => (
  typeof value === 'string' && value.trim() ? value.trim() : 'Choose one'
);

/** The `render_choices` details, or `null` when the shape is not ours. */
export const parseChoiceDetails = (metadata: unknown): ChoiceDetails | null => {
  if (!metadata || typeof metadata !== 'object') return null;
  const record = metadata as Record<string, unknown>;
  const options = readOptions(record.options);
  // Details always carry what each option shows; input alone may not.
  if (!options || options.some((option) => option.html === undefined && option.image === undefined)) return null;
  const details: ChoiceDetails = { title: readTitle(record.title), options };
  if (record.answer === null) return { ...details, answer: null };
  if (record.answer && typeof record.answer === 'object') {
    const answer = record.answer as Record<string, unknown>;
    if (typeof answer.id !== 'string' || !options.some((option) => option.id === answer.id)) return details;
    const note = typeof answer.note === 'string' ? answer.note.trim() : '';
    return { ...details, answer: { id: answer.id, ...(note ? { note } : {}) } };
  }
  return details;
};

/**
 * The same shape from the call's input, for a call whose details this client
 * has not been sent (a session opened while the question waits). Options
 * given as a file keep only their `path`.
 */
export const choicesFromInput = (input: unknown): ChoiceDetails | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const options = readOptions(record.options);
  if (!options) return null;
  // Only the agent half encodes images; one named in the input is not shown.
  return {
    title: readTitle(record.title),
    options: options.map((option) => {
      const kept = { ...option };
      delete kept.image;
      return kept;
    }),
  };
};

/**
 * The same shape from the pending question alone, when neither the details
 * nor the input can be read: every choice stays answerable, without previews.
 * Visuals names its choices `A: Label`; the letter is the card's badge.
 */
export const choicesFromQuestion = (
  question: { title: string; choices: ReadonlyArray<{ id: string; label: string; description?: string }> },
): ChoiceDetails | null => {
  if (question.choices.length === 0) return null;
  return {
    title: readTitle(question.title),
    options: question.choices.map((choice) => {
      const prefix = `${choiceLetter(choice.id)}: `;
      const label = choice.label.startsWith(prefix) ? choice.label.slice(prefix.length) : choice.label;
      return { id: choice.id, label: label || choice.label, ...(choice.description ? { description: choice.description } : {}) };
    }),
  };
};

/**
 * The variant in the frame: the one the user switched to, else the chosen
 * one, else the first the waiting question offers, else the first.
 */
export const shownChoice = (
  options: ChoiceOption[],
  state: { picked?: string | null; chosenId?: string; offered?: readonly string[] },
): ChoiceOption => {
  const byId = (id: string | null | undefined) => (id ? options.find((option) => option.id === id) : undefined);
  return byId(state.picked)
    ?? byId(state.chosenId)
    ?? options.find((option) => state.offered?.includes(option.id))
    ?? options[0];
};

/** Characters of page written so far, for the placeholder while the call is written. */
export const choicesInputSize = (input: unknown): number => {
  const options = (input as { options?: unknown } | null | undefined)?.options;
  if (!Array.isArray(options)) return 0;
  return options.reduce((total: number, option) => {
    const html = (option as { html?: unknown } | null)?.html;
    return total + (typeof html === 'string' ? html.length : 0);
  }, 0);
};
