// Chat cards: `pichamber.card(ctx, card)`, or a `pichamber.card` entry an
// extension appends itself. Releases up to 1.0.7 used the `pichamber.ui`
// label, which saved sessions still hold, so the browser draws both
// (packages/ui/src/lib/pi/extension-ui.ts, the parser every card goes
// through). This module checks a card's shape before the daemon saves it, so
// `pichamber.card()` rejects what the browser could not take for a card. It
// does not check each component's props: the browser does, and draws props
// it cannot read as the generic card.

import { parseExtensionCommandName } from './extension-commands.js';

export const CARD_ENTRY_TYPE = 'pichamber.card';

export const CARD_COMPONENTS = Object.freeze(['markdown', 'kv', 'list', 'table', 'progress', 'badges', 'code']);
const COMPONENTS = new Set(CARD_COMPONENTS);
const MAX_ACTIONS = 8;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The card to save, or a reason it cannot be one. Fields the browser does not
 * read (`id`, `protocol`, `version`) are left out, so a card written through
 * `pichamber.card()` never turns into something else.
 */
export const normalizeExtensionCard = (raw) => {
  if (!isRecord(raw)) return { error: 'a card is an object' };
  if (typeof raw.component !== 'string' || !COMPONENTS.has(raw.component)) {
    return { error: `\`component\` is one of ${[...COMPONENTS].join(', ')}` };
  }
  if (raw.props !== undefined && !isRecord(raw.props)) return { error: '`props` is an object' };
  if (raw.title !== undefined && typeof raw.title !== 'string') return { error: '`title` is a string' };
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || raw.actions.length > MAX_ACTIONS) return { error: `\`actions\` is a list of up to ${MAX_ACTIONS}` };
    for (const action of raw.actions) {
      if (!isRecord(action) || typeof action.label !== 'string' || action.label.trim() === '') return { error: 'every action has a `label`' };
      if (!parseExtensionCommandName(action.command)) return { error: `action "${action.label}" names no valid command` };
      if (action.args !== undefined && typeof action.args !== 'string') return { error: `action "${action.label}" has \`args\` that is not a string` };
    }
  }
  return {
    card: {
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      component: raw.component,
      props: raw.props ?? {},
      ...(raw.actions ? { actions: raw.actions } : {}),
    },
  };
};
