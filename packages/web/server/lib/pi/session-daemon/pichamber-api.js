// PiChamber's extension API: the functions on `globalThis.pichamber`.
//
// They live on PiChamber's own object, not on Pi's `ctx.ui`, so a method Pi
// adds later with the same name and another shape cannot be shadowed by ours.
// Every function takes the tool or handler `ctx` first.
//
// The session's ui context carries the working implementations under a
// Symbol key. A Symbol cannot collide with any name Pi adds, and Pi's runner
// copies the ui context with an object spread, which keeps own symbol
// properties. `pichamber.x(ctx, ...)` reads them back from `ctx.ui`, so no
// session lookup is needed: `ctx` already identifies the session.

/** The one extension API version. A breaking change raises it. */
export const PICHAMBER_API_VERSION = 1;

export const PICHAMBER_API = Symbol.for('pichamber.api');

/** Every function of the API. `pichamber.d.ts` declares the same names. */
export const PICHAMBER_API_FUNCTIONS = Object.freeze(['choose', 'form', 'openUrl', 'card', 'control']);

/**
 * `{ apiVersion, choose, form, openUrl, card, control }`. Every call returns
 * a promise; a `ctx` with no PiChamber session behind it rejects with a
 * `TypeError` and never throws synchronously.
 */
export const createPichamberApi = () => {
  const api = { apiVersion: PICHAMBER_API_VERSION };
  for (const name of PICHAMBER_API_FUNCTIONS) {
    api[name] = async (ctx, ...args) => {
      const impl = ctx?.ui?.[PICHAMBER_API]?.[name];
      if (typeof impl !== 'function') {
        throw new TypeError(`pichamber.${name} needs the tool or handler \`ctx\` of a PiChamber session as its first argument.`);
      }
      return impl(...args);
    };
  }
  return Object.freeze(api);
};
