import { normalizeCombo, UNASSIGNED_SHORTCUT } from '@/lib/shortcuts';

/**
 * User-authored command triggers ("quick actions"): buttons near the composer
 * and optional global keybindings that fire a slash command through the normal
 * authenticated prompt path. Triggers never dispatch arbitrary functions —
 * the browser only ever asks the active session to run `/<command> <args>`.
 */

export interface CommandTrigger {
  id: string;
  /** Button label. */
  label: string;
  /** Registered command name without the leading `/`. */
  command: string;
  /** Optional argument string appended after the command. */
  args?: string;
  /**
   * Optional global keybinding as a normalized shortcut combo
   * (`@/lib/shortcuts`). Absent or `__unassigned__` means keyboard-less.
   */
  combo?: string;
}

export const MAX_COMMAND_TRIGGERS = 12;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const asBoundedString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

/** Validate and normalize an untrusted triggers array (settings payload). */
export const sanitizeCommandTriggers = (value: unknown): CommandTrigger[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const triggers: CommandTrigger[] = [];
  const seenIds = new Set<string>();
  for (const raw of value.slice(0, MAX_COMMAND_TRIGGERS)) {
    if (!isRecord(raw)) continue;
    const label = asBoundedString(raw.label, 64);
    const command = asBoundedString(raw.command, 128);
    if (!label || !command) continue;
    // Same rule as extension card actions: triggers run through the prompt
    // path, so embedded path separators would be ambiguous or hostile.
    if (command.includes('/') || command.startsWith('.')) continue;
    let id = asBoundedString(raw.id, 64);
    if (!id || seenIds.has(id)) id = `trigger-${triggers.length + 1}-${command}`;
    seenIds.add(id);
    const args = asBoundedString(raw.args, 2_000);
    const comboRaw = typeof raw.combo === 'string' && raw.combo.length > 0 ? normalizeCombo(raw.combo) : undefined;
    const combo = comboRaw && comboRaw !== UNASSIGNED_SHORTCUT ? comboRaw : undefined;
    triggers.push({
      id,
      label,
      command,
      ...(args !== undefined ? { args } : {}),
      ...(combo !== undefined ? { combo } : {}),
    });
  }
  return triggers.length > 0 ? triggers : undefined;
};

export const normalizeCommandArgs = (args?: string): string => (
  Array.from(args ?? '', (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('').trim().slice(0, 2_000)
);

export const buildCommandPromptText = (command: string, args?: string): string => {
  const normalizedArgs = normalizeCommandArgs(args);
  return normalizedArgs ? `/${command} ${normalizedArgs}` : `/${command}`;
};

export const triggerPromptText = (trigger: CommandTrigger): string => (
  buildCommandPromptText(trigger.command, trigger.args)
);
