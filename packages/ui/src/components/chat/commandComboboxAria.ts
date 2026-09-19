/**
 * Stable, collision-safe IDs for the slash-command combobox.
 *
 * The focused CodeMirror content owns the combobox semantics
 * (`role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`)
 * while the palette renders the `listbox`/`option` side. These helpers keep
 * that linkage pure so it can be unit-tested without a DOM.
 */

/** Strip React `useId` decoration (`:`) so the ID survives selectors. */
export function sanitizeComboboxIdSegment(rawId: string): string {
  return rawId.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Listbox ID for one mounted `CommandAutocomplete` instance. */
export function commandListboxId(sanitized: string): string {
  const suffix = sanitized.length > 0 ? sanitized : "commands";
  return `command-listbox-${suffix}`;
}

/** Option ID for `index` inside `listboxId`. */
export function commandOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

export interface CommandActiveOptionInput {
  loading: boolean;
  /** True when `commands[selectedIndex]` exists (the palette's own guard). */
  hasSelectedCommand: boolean;
  selectedIndex: number;
  listboxId: string;
}

/**
 * Active-descendant option ID, or `undefined` when the palette's existing
 * valid conditions are not met (loading, or no command at the selection).
 * Callers must remove a stale `aria-activedescendant` when this is undefined.
 */
export function resolveCommandActiveOptionId(
  input: CommandActiveOptionInput,
): string | undefined {
  if (input.loading) return undefined;
  if (!input.hasSelectedCommand) return undefined;
  return commandOptionId(input.listboxId, input.selectedIndex);
}
