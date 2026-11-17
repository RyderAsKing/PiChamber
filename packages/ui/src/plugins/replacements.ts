import type {
  PiExtensionConfigItem,
  PiExtensionConfigResponse,
  PiExtensionReplacement,
} from '@/lib/pi/protocol';

/**
 * Pi loads only one extension per tool, command, or flag name, and a plugin
 * or built-in gives way to the user's own extension. The server reports what
 * a live session left out (`PiExtensionConfigResponse.replaced`); these
 * helpers turn it into rows and sentences. See `DOCUMENTATION.md`.
 */
export const findReplacement = (
  config: PiExtensionConfigResponse | null | undefined,
  kind: PiExtensionReplacement['kind'],
  id: string,
): PiExtensionReplacement | undefined => (
  config?.replaced?.find((entry) => entry.kind === kind && entry.id === id)
);

/** One line for a list row. */
export const replacementLine = (replacement: PiExtensionReplacement): string => (
  replacement.by
    ? `Not loaded: ${replacement.by.name} takes its place`
    : 'Not loaded: another extension takes its place'
);

const sharedName = (replacement: PiExtensionReplacement): string => {
  if (!replacement.registers) return 'the same tool, command, or flag';
  const { kind, name } = replacement.registers;
  if (kind === 'command') return `the /${name} command`;
  if (kind === 'flag') return `the --${name} flag`;
  return `the ${name} tool`;
};

/** Why it is not loaded, in two sentences. */
export const replacementReason = (replacement: PiExtensionReplacement): string => (
  `Pi loads ${replacement.by?.name ?? 'another extension'} instead. Both register ${sharedName(replacement)}, and Pi keeps only one.`
);

interface ReplacementFix {
  /** The extension to turn off, by its id in the same list. */
  id: string;
  name: string;
  /** `global`: off in Pi's global settings. `project`: off in this project only. */
  scope: 'global' | 'project';
}

/**
 * The one write that lets the plugin or built-in load again, when there is
 * one: turning off the extension that took its place, in the scope that
 * loads it. `null` when the list does not have that extension, when this
 * project turns it on itself over a global setting, or when the project is
 * not trusted.
 */
export const replacementFix = (
  config: PiExtensionConfigResponse | null | undefined,
  replacement: PiExtensionReplacement,
): ReplacementFix | null => {
  const winnerId = replacement.by?.id;
  if (!config || !winnerId) return null;
  const item: PiExtensionConfigItem | undefined = config.extensions.find((entry) => entry.id === winnerId);
  if (!item) return null;
  if (item.global !== undefined) {
    if (!item.global || item.project?.state === 'load') return null;
    return { id: item.id, name: item.name, scope: 'global' };
  }
  if (item.scope === 'project' && item.project?.enabled && config.project.trusted && config.directory) {
    return { id: item.id, name: item.name, scope: 'project' };
  }
  return null;
};

/**
 * Notes for the extension rows of one list: the built-ins left out, and the
 * extensions loaded in their place or in a plugin's place.
 */
export const replacementNotes = (
  config: PiExtensionConfigResponse,
  pluginNames: Record<string, string>,
): Map<string, { text: string; warning: boolean }> => {
  const notes = new Map<string, { text: string; warning: boolean }>();
  const itemName = new Map(config.extensions.map((item) => [item.id, item.name]));
  for (const replacement of config.replaced ?? []) {
    const target = replacement.kind === 'plugin'
      ? pluginNames[replacement.id] && `the ${pluginNames[replacement.id]} plugin`
      : itemName.get(replacement.id) && `Pi's ${itemName.get(replacement.id)}`;
    if (!target) continue;
    if (replacement.kind === 'builtin') {
      notes.set(replacement.id, { text: replacementLine(replacement), warning: true });
    }
    const winnerId = replacement.by?.id;
    if (winnerId && itemName.has(winnerId) && !notes.has(winnerId)) {
      notes.set(winnerId, { text: `Loaded in place of ${target}`, warning: false });
    }
  }
  return notes;
};
