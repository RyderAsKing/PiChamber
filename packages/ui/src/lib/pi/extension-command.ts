/**
 * The one rule for an extension naming one of its own slash commands, shared
 * by card actions in the browser.
 * The server owns the rule (`packages/web/server/lib/pi/extension-commands.js`)
 * and enforces it again before anything runs; keep the two in step.
 *
 * - The name is Pi's invocation name: a letter or digit, then letters,
 *   digits, `_`, `.`, `:` or `-`, up to 128 characters. One leading `/` is
 *   allowed and dropped.
 * - Arguments become one trimmed line of at most 2,000 characters.
 */

const EXTENSION_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** `review` or `/review` → `review`; undefined when it is not a command name. */
export const parseExtensionCommandName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const name = value.startsWith('/') ? value.slice(1) : value;
  return EXTENSION_COMMAND_NAME_PATTERN.test(name) ? name : undefined;
};
