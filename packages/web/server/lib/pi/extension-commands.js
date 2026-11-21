// The one rule for an extension naming one of its own slash commands.
//
// Composer controls and card actions both name a command the extension registered, and a click runs it
// through `extensions.command`/`extensions.control`, which refuse a name Pi
// has not registered. They share this module so the same command is valid in
// every one of them:
//
// - The name is Pi's invocation name: a letter or digit, then letters,
//   digits, `_`, `.`, `:` or `-`, up to 128 characters. Pi adds `:<n>` to
//   tell two extensions' commands of the same name apart. One leading `/` is
//   allowed and dropped.
// - Arguments are one line: control characters become spaces, the ends are
//   trimmed, and at most 2,000 characters are kept.
//
// The browser keeps a copy of this rule in
// `packages/ui/src/lib/pi/extension-command.ts`; keep the two in step.

export const EXTENSION_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_EXTENSION_COMMAND_ARGS_CHARS = 2_000;

/** `review` or `/review` → `review`; null when it is not a command name. */
export const parseExtensionCommandName = (value) => {
  if (typeof value !== 'string') return null;
  const name = value.startsWith('/') ? value.slice(1) : value;
  return EXTENSION_COMMAND_NAME_PATTERN.test(name) ? name : null;
};

/** Arguments as one trimmed line of at most 2,000 characters ('' when none). */
export const normalizeExtensionCommandArgs = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_EXTENSION_COMMAND_ARGS_CHARS);
};

/**
 * A command with its arguments in one string (`/plan on` or `plan on`) →
 * `plan on`; null when the part before the first space is not a command name.
 */
export const parseExtensionCommandText = (value) => {
  if (typeof value !== 'string') return null;
  const text = normalizeExtensionCommandArgs(value);
  const space = text.indexOf(' ');
  const name = parseExtensionCommandName(space === -1 ? text : text.slice(0, space));
  if (!name) return null;
  const args = space === -1 ? '' : text.slice(space + 1).trim();
  return args ? `${name} ${args}` : name;
};

/** The command's invocation name: the part before the first space. */
export const commandName = (command) => command.split(' ')[0];
