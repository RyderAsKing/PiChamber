/**
 * PiChamber extension GUI protocol (v1) — parsing side.
 *
 * pi extensions running inside the session daemon can surface rich UI in
 * PiChamber by appending a custom entry or sending a custom message with the
 * `pichamber.ui` customType whose payload is a declarative descriptor:
 *
 * ```ts
 * pi.appendEntry("pichamber.ui", {
 *   title: "Explore progress",
 *   component: "progress",
 *   props: { label: "Files indexed", value: 40, max: 100 },
 *   actions: [{ label: "Focus repo", command: "explore:focus", args: "src" }],
 * });
 * ```
 *
 * Everything is display-only JSON: no markup injection, no arbitrary component
 * execution. Unknown components fall back to a generic card so extensions
 * never break the chat. Actions map to registered extension slash commands
 * that PiChamber invokes through the normal prompt path.
 */

import { normalizeCommandArgs } from './command-triggers';

export const PI_EXTENSION_UI_CUSTOM_TYPE = 'pichamber.ui';

/** Custom types prefixed with this namespace are treated as PiChamber GUI. */
export const PI_EXTENSION_UI_NAMESPACE = 'pichamber.';

/** Versioned protocol marker for the declarative UI surface. */
export const PI_EXTENSION_UI_PROTOCOL = 'pichamber-extension-ui';
export const PI_EXTENSION_UI_VERSION = 1;

export type ExtensionUiTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface ExtensionUiAction {
  /** Button label. */
  label: string;
  /** Registered extension command name without the leading `/`. */
  command: string;
  /** Optional argument string appended after the command. */
  args?: string;
  variant?: 'default' | 'outline' | 'ghost';
  /** Optional icon name rendered before the label (PiChamber sprite name). */
  icon?: string;
  /** Rendered disabled; clicks are ignored. */
  disabled?: boolean;
  /** Show a spinner instead of relying only on transport-level pending state. */
  loading?: boolean;
  /** Ask for explicit confirmation (browser dialog) before invoking. */
  confirm?: string;
  /** Collect an argument string through a blocking input before invoking. */
  promptForArgs?: {
    label?: string;
    placeholder?: string;
  };
}

export interface ExtensionUiRow {
  label: string;
  value: string;
  tone?: ExtensionUiTone;
}

interface ExtensionUiComponentBase {
  title?: string;
}

export type ExtensionUiComponent =
  | ({ component: 'markdown'; body: string } & ExtensionUiComponentBase)
  | ({ component: 'kv'; rows: ExtensionUiRow[] } & ExtensionUiComponentBase)
  | ({ component: 'table'; columns: string[]; rows: string[][] } & ExtensionUiComponentBase)
  | ({ component: 'progress'; label?: string; value: number; max?: number } & ExtensionUiComponentBase)
  | ({ component: 'badges'; items: Array<{ label: string; tone?: ExtensionUiTone }> } & ExtensionUiComponentBase)
  | ({ component: 'list'; items: ExtensionUiRow[] } & ExtensionUiComponentBase)
  | ({ component: 'code'; language?: string; code: string } & ExtensionUiComponentBase);

export interface ExtensionUiDescriptor {
  /** Stable identity; later entries with the same id may replace this card. */
  id?: string;
  title?: string;
  /** Validated, render-ready component description. */
  component: ExtensionUiComponent;
  actions?: ExtensionUiAction[];
}

/** What an extension-authored chat item renders as in PiChamber. */
export type ParsedExtensionItem =
  | { kind: 'ui'; descriptor: ExtensionUiDescriptor }
  | { kind: 'fallback'; title: string; body: string };

const TONES: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'error', 'neutral']);

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' ? value : undefined
);

const asFiniteNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const parseTone = (value: unknown): ExtensionUiTone => {
  const candidate = asString(value);
  return candidate && TONES.has(candidate) ? candidate as ExtensionUiTone : 'neutral';
};

const parseRows = (value: unknown): ExtensionUiRow[] | null => {
  if (!Array.isArray(value)) return null;
  const rows: ExtensionUiRow[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    if (!record) continue;
    const label = asString(record.label);
    if (label === undefined) continue;
    rows.push({
      label,
      value: asString(record.value) ?? '',
      ...(record.tone !== undefined ? { tone: parseTone(record.tone) } : {}),
    });
  }
  return rows;
};

const MAX_ACTION_LABEL = 128;

const truncateActionText = (value: string, maxLength: number): string => (
  value.length > maxLength ? value.slice(0, maxLength) : value
);

export const normalizeExtensionCommandArgs = (value: string | undefined): string => normalizeCommandArgs(value);

const parseActions = (value: unknown): ExtensionUiAction[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const actions: ExtensionUiAction[] = [];
  for (const raw of value.slice(0, 8)) {
    const record = asRecord(raw);
    if (!record) continue;
    const label = asString(record.label);
    const command = asString(record.command);
    if (!label || !command) continue;
    // Commands are invoked through the prompt path, which requires "/"-prefixed
    // text — keep the stored form clean and reject embedded separators.
    if (command.includes('/') || command.startsWith('.')) continue;
    const promptForArgsSource = asRecord(record.promptForArgs);
    const promptLabel = promptForArgsSource ? asString(promptForArgsSource.label) : undefined;
    const promptPlaceholder = promptForArgsSource ? asString(promptForArgsSource.placeholder) : undefined;
    actions.push({
      label: truncateActionText(label, MAX_ACTION_LABEL),
      command,
      ...(asString(record.args) !== undefined ? { args: normalizeExtensionCommandArgs(asString(record.args)) } : {}),
      ...(record.variant === 'outline' || record.variant === 'ghost' ? { variant: record.variant } : {}),
      ...(asString(record.icon) !== undefined ? { icon: truncateActionText(asString(record.icon) ?? '', 64) } : {}),
      ...(record.disabled === true ? { disabled: true } : {}),
      ...(record.loading === true ? { loading: true } : {}),
      ...(asString(record.confirm) !== undefined ? { confirm: truncateActionText(asString(record.confirm) ?? '', 500) } : {}),
      ...(promptForArgsSource
        ? {
            promptForArgs: {
              ...(promptLabel !== undefined ? { label: truncateActionText(promptLabel, 256) } : {}),
              ...(promptPlaceholder !== undefined ? { placeholder: truncateActionText(promptPlaceholder, 256) } : {}),
            },
          }
        : {}),
    });
  }
  return actions.length > 0 ? actions : undefined;
};

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

const parseProps = (
  component: string,
  props: Record<string, unknown>,
): DistributiveOmit<ExtensionUiComponent, 'title'> | null => {
  switch (component) {
    case 'markdown': {
      const body = asString(props.body) ?? asString(props.text);
      return body !== undefined ? { component: 'markdown', body } : null;
    }
    case 'kv': {
      const rows = parseRows(props.rows);
      return rows && rows.length > 0 ? { component: 'kv', rows } : null;
    }
    case 'list': {
      const items = parseRows(props.items ?? props.rows);
      return items && items.length > 0 ? { component: 'list', items } : null;
    }
    case 'table': {
      if (!Array.isArray(props.columns) || !Array.isArray(props.rows)) return null;
      const columns = props.columns.map((column) => asString(column) ?? '').filter((column) => column.length > 0);
      if (columns.length === 0) return null;
      const rows: string[][] = [];
      for (const raw of props.rows.slice(0, 200)) {
        if (!Array.isArray(raw)) continue;
        rows.push(raw.map((cell) => asString(cell) ?? '').slice(0, columns.length));
      }
      return rows.length > 0 ? { component: 'table', columns, rows } : null;
    }
    case 'progress': {
      const value = asFiniteNumber(props.value);
      if (value === undefined) return null;
      const max = asFiniteNumber(props.max) ?? 100;
      return {
        component: 'progress',
        value,
        max: max > 0 ? max : 100,
        ...(asString(props.label) !== undefined ? { label: asString(props.label) } : {}),
      };
    }
    case 'badges': {
      if (!Array.isArray(props.items)) return null;
      const items = props.items
        .map((raw) => {
          const record = asRecord(raw);
          if (record) {
            const label = asString(record.label);
            if (label) return { label, tone: parseTone(record.tone) };
            return null;
          }
          const label = asString(raw);
          return label ? { label, tone: 'neutral' as const } : null;
        })
        .filter((item): item is { label: string; tone: ExtensionUiTone } => item !== null)
        .slice(0, 24);
      return items.length > 0 ? { component: 'badges', items } : null;
    }
    case 'code': {
      const code = asString(props.code);
      return code !== undefined
        ? { component: 'code', code, ...(asString(props.language) !== undefined ? { language: asString(props.language) } : {}) }
        : null;
    }
    default:
      return null;
  }
};

const truncateForFallback = (value: string, maxLength = 2_000): string => (
  value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
);

/**
 * Parse one extension-authored chat item into its renderable form.
 * `payload` prefers the entry `data`; message details/text feed the fallback.
 */
export const parseExtensionChatItem = (input: {
  customType?: string;
  data?: unknown;
  details?: unknown;
  text?: string;
}): ParsedExtensionItem => {
  const namespaced = input.customType === PI_EXTENSION_UI_CUSTOM_TYPE
    || (input.customType?.startsWith(PI_EXTENSION_UI_NAMESPACE) ?? false);

  const source = namespaced
    ? (asRecord((asRecord(input.data)?.ui) ?? null) ?? asRecord(input.data) ?? asRecord(input.details))
    : null;

  if (source) {
    // Version gate: unknown major versions degrade to fallback so a future
    // breaking schema does not crash older clients. Minor forward-compat will
    // be handled by lenient parsing below.
    const protocol = asString(source.protocol);
    const version = asFiniteNumber(source.version);
    if (protocol && protocol !== PI_EXTENSION_UI_PROTOCOL) {
      // Unknown protocol -> fallback
    } else if (version !== undefined && version !== PI_EXTENSION_UI_VERSION) {
      // Future version -> fallback (payload remains visible as JSON)
    } else {
      const componentName = asString(source.component) ?? asString(source.type);
      if (componentName) {
        const rawProps = asRecord(source.props) ?? {};
        const parsedComponent = parseProps(componentName, rawProps);
        const actions = parseActions(source.actions);
        if (parsedComponent || actions) {
          const title = asString(source.title);
          return {
            kind: 'ui',
            descriptor: {
              ...(asString(source.id) !== undefined ? { id: asString(source.id)?.slice(0, 128) } : {}),
              ...(title !== undefined ? { title: title.slice(0, 256) } : {}),
              // (title fallback handled by callers via component.title when present)
              // Unrecognized component names still render their actions through
              // a generic card body instead of being dropped.
              component: parsedComponent ?? { component: 'markdown', body: '' },
              ...(actions ? { actions } : {}),
            },
          };
        }
      }
      // If customType is namespaced but contains no renderable component,
      // treat the whole payload (or its `ui` sub-object) as a potential
      // title-bearing fallback rather than dropping it silently.
      if (asString(source.title) || asString(source.text) || asString(source.body)) {
        const fallbackBody = asString(source.text) ?? asString(source.body) ?? '';
        if (fallbackBody) {
          const actions = parseActions(source.actions);
          return {
            kind: 'ui',
            descriptor: {
              ...(asString(source.id) !== undefined ? { id: asString(source.id)?.slice(0, 128) } : {}),
              ...(asString(source.title) !== undefined ? { title: asString(source.title)?.slice(0, 256) } : {}),
              component: { component: 'markdown', body: fallbackBody.slice(0, 5000) },
              ...(actions ? { actions } : {}),
            },
          };
        }
      }
    }
  }

  const bodyParts: string[] = [];
  if (typeof input.text === 'string' && input.text.trim().length > 0) bodyParts.push(input.text.trim());
  if (input.data !== undefined) {
    try {
      bodyParts.push(truncateForFallback(JSON.stringify(input.data, null, 2)));
    } catch {
      bodyParts.push('[unserializable data]');
    }
  } else if (input.details !== undefined) {
    try {
      bodyParts.push(truncateForFallback(JSON.stringify(input.details, null, 2)));
    } catch {
      bodyParts.push('[unserializable details]');
    }
  }

  return {
    kind: 'fallback',
    title: input.customType ?? 'Extension',
    body: bodyParts.join('\n\n'),
  };
};
