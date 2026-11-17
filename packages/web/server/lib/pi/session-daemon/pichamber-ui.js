// PiChamber's own dialog calls (`choose`, `form`, `openUrl`) live on a
// `pichamber` object, not on Pi's `ctx.ui`, so a method Pi adds later with
// the same name and another shape cannot be shadowed by ours.
//
// The session's ui context carries the working implementations under a
// Symbol key. A Symbol cannot collide with any name Pi adds, and Pi's runner
// copies the ui context with an object spread, which keeps own symbol
// properties. `pichamber.ui.x(ctx, ...)` reads them back from `ctx.ui`, so no
// session lookup is needed: `ctx` already identifies the session.

export const PICHAMBER_UI = Symbol.for('pichamber.ui');

const NAMES = ['choose', 'form', 'openUrl'];

const missingContext = (name) => new TypeError(
  `pichamber.ui.${name} needs the tool or handler \`ctx\` of a PiChamber session as its first argument.`,
);

/**
 * `{ choose, form, openUrl }`, each taking `ctx` first. Every call returns a
 * promise; a `ctx` with no PiChamber session behind it rejects with a
 * `TypeError` and never throws synchronously.
 */
export const createPichamberUi = () => {
  const ui = {};
  for (const name of NAMES) {
    ui[name] = async (ctx, ...args) => {
      const impl = ctx?.ui?.[PICHAMBER_UI]?.[name];
      if (typeof impl !== 'function') throw missingContext(name);
      return impl(...args);
    };
  }
  return Object.freeze(ui);
};

/**
 * Stand-in `ui` whose calls resolve with nothing, for measuring a plugin
 * without a session (`openUrl` resolves `false`).
 */
export const createInertPichamberUi = () => Object.freeze({
  choose: async () => undefined,
  form: async () => undefined,
  openUrl: async () => false,
});
