/**
 * The composer's local slash commands.
 *
 * Most of them do the same thing: render a pair of utility prompts — one the
 * user sees, one the model is instructed with — and send them as a single
 * message. That shape was previously written out nine times as an `else if`
 * chain, so adding a command meant copying twenty lines and remembering to
 * change every string in them. Here the shape is the executor and the
 * commands are data.
 *
 * Commands that are not "send a prompt pair" (undo, redo, timeline, compact,
 *) stay with the composer: they manipulate session state or
 * open UI rather than producing a message.
 */

export interface ParsedSlashCommand {
    name: string;
    /** Everything typed after the command name, trimmed. */
    argument: string;
}

/**
 * Read the leading slash command out of a message, if there is one. Only the
 * first word counts as the command; the rest is its argument.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('/')) return null;

    const withoutSlash = trimmed.slice(1);
    const name = withoutSlash.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!name) return null;

    return {
        name,
        argument: withoutSlash.slice(name.length).trim(),
    };
}
