/**
 * Types for PiChamber's extension API, version 1: everything on
 * `globalThis.pichamber`. This file imports nothing, so an extension can copy
 * it next to its code or read it from `@pi-chamber/web/pichamber`.
 *
 *   const { pichamber } = globalThis;
 *   if (pichamber) await pichamber.card(ctx, { title: 'Done', component: 'markdown', props: { body: 'All green.' } });
 *
 * `pichamber` is undefined in the Pi CLI, so that check is also how an
 * extension detects PiChamber. Every function takes the tool or handler `ctx`
 * first and returns a promise; bad input rejects with a `TypeError`.
 */

/** The `ctx` Pi passes to a tool, command or event handler. */
export interface PiChamberContext {
  ui: object;
}

export interface PiChamberChoice {
  /** Up to 64 characters; returned as the answer. */
  id: string;
  label: string;
  description?: string;
}

export interface PiChamberDialogOptions {
  signal?: AbortSignal;
  /** Milliseconds before the dialog closes without an answer. */
  timeout?: number;
}

export interface PiChamberChooseOptions extends PiChamberDialogOptions {
  /** Text shown under the title. */
  message?: string;
  /** Let the user add a note to the choice. */
  allowNote?: boolean;
  /** The tool call that asks, so the question shows beside it. */
  toolCallId?: string;
}

export interface PiChamberFormField {
  id: string;
  label: string;
  /** Defaults to `text`. */
  type?: 'text' | 'textarea' | 'number' | 'select' | 'checkbox';
  required?: boolean;
  placeholder?: string;
  /** For `select`. */
  options?: string[];
  initial?: string;
  /** For `number`. */
  min?: number;
  max?: number;
}

export type PiChamberTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface PiChamberRow {
  label: string;
  value: string;
  tone?: PiChamberTone;
}

/** A button on a card. It runs one of the extension's registered commands. */
export interface PiChamberCardAction {
  label: string;
  /** A registered command name, with or without the leading `/`. */
  command: string;
  args?: string;
  variant?: 'default' | 'outline' | 'ghost';
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Ask this question before running the command. */
  confirm?: string;
  /** Ask for the arguments before running the command. */
  promptForArgs?: { label?: string; placeholder?: string };
}

type PiChamberCardBody =
  | { component: 'markdown'; props: { body: string } }
  | { component: 'kv'; props: { rows: PiChamberRow[] } }
  | { component: 'list'; props: { items: PiChamberRow[] } }
  | { component: 'table'; props: { columns: string[]; rows: string[][] } }
  | { component: 'progress'; props: { label?: string; value: number; max?: number } }
  | { component: 'badges'; props: { items: Array<{ label: string; tone?: PiChamberTone }> } }
  | { component: 'code'; props: { language?: string; code: string } };

/** A card in the chat. Saved in the session, so it is there after a reload. */
export type PiChamberCard = PiChamberCardBody & {
  title?: string;
  /** Up to 8. */
  actions?: PiChamberCardAction[];
};

interface PiChamberControlBase {
  /** Lowercase letters, digits and dashes, up to 40. Declaring an id again replaces it. */
  id: string;
  /** Up to 40 characters. */
  label: string;
  description?: string;
  icon?: string;
}

/**
 * A control in the composer. The extension keeps the value: a click runs
 * `command`, and the command's handler calls `pichamber.control` again with
 * the new value.
 */
export type PiChamberControl =
  | (PiChamberControlBase & { kind: 'toggle'; value: boolean; command: string })
  | (PiChamberControlBase & {
      kind: 'cycle';
      value?: string;
      /** 2 to 12 options, each with its own command. */
      options: Array<{ value: string; label?: string; command: string }>;
    })
  | (PiChamberControlBase & { kind: 'action'; command: string })
  | { id: string; remove: true };

export interface PiChamber {
  /** Raised only by a breaking change. New functions do not raise it; test for them. */
  readonly apiVersion: 1;
  /** One question with up to 12 choices. Resolves the choice, or `undefined` when dismissed. */
  choose(ctx: PiChamberContext, title: string, choices: PiChamberChoice[], options?: PiChamberChooseOptions): Promise<{ id: string; note?: string } | undefined>;
  /** One dialog with up to 12 fields. Resolves the values by field id, or `undefined` when cancelled. */
  form(ctx: PiChamberContext, title: string, fields: PiChamberFormField[], options?: PiChamberDialogOptions): Promise<Record<string, string> | undefined>;
  /** Show an http(s) link to the user. Resolves whether it was shown or opened. */
  openUrl(ctx: PiChamberContext, url: string): Promise<boolean>;
  /** Add a card to the chat. */
  card(ctx: PiChamberContext, card: PiChamberCard): Promise<void>;
  /** Add, update or remove a control in the composer. Declare them at `session_start`. */
  control(ctx: PiChamberContext, control: PiChamberControl): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var pichamber: PiChamber | undefined;
}
