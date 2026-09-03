/**
 * Pi prompt argument variables for the prompt-template editor.
 *
 * Positional insertion continues the sequence already present in the content:
 * tapping the first chip inserts one past the highest `$n` in use.
 */

/** Highest bare `$n` positional reference in content, or 0 when none is present. */
export function maxPositionalNumber(content: string): number {
  let max = 0;
  const pattern = /\$(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const found = Number.parseInt(match[1] ?? "", 10);
    if (Number.isSafeInteger(found) && found > max) {
      max = found;
    }
  }
  return max;
}

/** Next positional variable to insert, e.g. "$3" when $2 is the highest present. */
export function nextPositionalVariable(content: string): string {
  return `$${maxPositionalNumber(content) + 1}`;
}

/**
 * Rest slice covering all arguments after the positional ones in use,
 * e.g. "${@:3}" when $2 is the highest present. Null when no positional
 * is in use yet, since the rest would just duplicate $@.
 */
export function restSliceVariable(content: string): string | null {
  const max = maxPositionalNumber(content);
  if (max < 1) return null;
  return `\${@:${max + 1}}`;
}

export interface PromptVariableChip {
  value: string;
  label: string;
  hint: string;
}

/** Variable chips for the Write-mode editor, resolved against current content. */
export function promptVariableChips(content: string): PromptVariableChip[] {
  const next = nextPositionalVariable(content);
  const rest = restSliceVariable(content);
  return [
    { value: next, label: next, hint: `Insert ${next}, the next argument` },
    { value: "$@", label: "$@", hint: "Insert $@, all arguments" },
    ...(rest ? [{ value: rest, label: rest, hint: `Insert ${rest}, all arguments after the positional ones` }] : []),
  ];
}
