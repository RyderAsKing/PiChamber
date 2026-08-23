/**
 * PiChamber GUI helper for pi extensions.
 *
 * Copy this file into your extension repository or vendor it, or import the
 * snippet from PiChamber's docs. It has no runtime dependency on PiChamber
 * itself: in plain pi CLI the `pichamber.ui` entries still round-trip as
 * persisted data and degrade to a generic JSON card instead of breaking.
 *
 * Detect PiChamber at runtime and publish declarative UI that PiChamber
 * renders natively (markdown, tables, progress, badges, etc.) without
 * arbitrary HTML or React injection.
 */

// Minimal shapes so this helper has no hard dependency on the pi SDK package
// (which lives in @pichamber/web). An extension can copy this file as-is.
export interface ExtensionApiLike {
  appendEntry: (customType: string, data?: unknown) => void;
  sendMessage?: (message: { customType: string; content: string; display?: boolean; details?: unknown }, options?: unknown) => void;
}
export interface ExtensionContextLike {
  mode: string;
  hasUI: boolean;
}

export const PICHAMBER_UI_CUSTOM_TYPE = 'pichamber.ui';
export const PICHAMBER_UI_PROTOCOL = 'pichamber-extension-ui';
export const PICHAMBER_UI_VERSION = 1;

export type PichamberTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export type PichamberAction = {
  label: string;
  command: string;
  args?: string;
  variant?: 'default' | 'outline' | 'ghost';
};

export type PichamberComponent =
  | { component: 'markdown'; props: { body: string } }
  | { component: 'kv'; props: { rows: Array<{ label: string; value: string; tone?: PichamberTone }> } }
  | { component: 'list'; props: { items: Array<{ label: string; value: string; tone?: PichamberTone }> } }
  | { component: 'table'; props: { columns: string[]; rows: string[][] } }
  | { component: 'progress'; props: { label?: string; value: number; max?: number } }
  | { component: 'badges'; props: { items: Array<{ label: string; tone?: PichamberTone } | string> } }
  | { component: 'code'; props: { code: string; language?: string } };

export interface PichamberUiDescriptor {
  id?: string;
  title?: string;
  version?: number;
  protocol?: string;
  actions?: PichamberAction[];
  component: PichamberComponent['component'];
  props: PichamberComponent['props'];
  // Shorthand top-level sugar that `publishPichamberUI` normalizes.
  body?: string;
}

/**
 * True when this extension instance is running inside PiChamber's daemon.
 * Call inside an event handler where `ctx` is available.
 *
 * The check is intentionally lenient so it keeps working without an extra
 * dependency: PiChamber sets `globalThis.__PICHAMBER__` and `process.env.PICHAMBER`
 * before loading extensions, and falls back to the RPC+UI mode hint.
 */
export const isPiChamber = (ctx?: Pick<ExtensionContextLike, 'mode' | 'hasUI'>): boolean => {
  const marker = (globalThis as unknown as Record<string, unknown>).__PICHAMBER__ as
    | { version?: number }
    | undefined;
  if (marker?.version) return true;
  try {
    if (typeof process !== 'undefined' && process.env?.PICHAMBER === '1') return true;
  } catch {
    // Ignore missing process polyfill in browser/bundled contexts.
  }
  if (ctx) return ctx.mode === 'rpc' && ctx.hasUI === true;
  return false;
};

/**
 * Publish a declarative PiChamber card. The payload is validated server-side
 * and rendered as a native card in PiChamber's chat; in the pi CLI it appears
 * as a fallback JSON card rather than breaking.
 *
 * ```ts
 * publishPichamberUI(pi, {
 *   id: 'subagents',
 *   title: 'Sub-agents',
 *   component: 'table',
 *   props: { columns: ['Agent','Status'], rows: [['research','running']] },
 *   actions: [{ label: 'Cancel', command: 'subagents-cancel', args: 'research' }],
 * });
 * ```
 */
export const publishPichamberUI = (
  pi: Pick<ExtensionApiLike, 'appendEntry'>,
  descriptor: PichamberUiDescriptor & { component: string; props: Record<string, unknown> },
): void => {
  const normalized: Record<string, unknown> = {
    protocol: PICHAMBER_UI_PROTOCOL,
    version: descriptor.version ?? PICHAMBER_UI_VERSION,
    ...(descriptor.id ? { id: descriptor.id.slice(0, 128) } : {}),
    ...(descriptor.title ? { title: descriptor.title.slice(0, 256) } : {}),
    component: descriptor.component,
    props: descriptor.props,
    ...(descriptor.actions ? { actions: descriptor.actions.slice(0, 8) } : {}),
  };
  // Prefer the appendEntry transcript path so the card survives reloads and
  // is visible to late-joining devices. `sendMessage` is an alternative when
  // the author wants the card to participate in LLM context.
  pi.appendEntry(PICHAMBER_UI_CUSTOM_TYPE, normalized);
};

/**
 * Minimal sub-agent example state helper: call this from your sub-agent
 * lifecycle (spawn / progress / complete) to keep a single live card in sync.
 * Later calls with the same `id` replace the earlier card in PiChamber's
 * rendering while older entries remain as history fallback in the CLI.
 */
export const publishSubagentPanel = (
  pi: Pick<ExtensionApiLike, 'appendEntry'>,
  agents: Array<{
    id: string;
    name: string;
    status: 'running' | 'done' | 'error' | 'idle';
    task?: string;
    progress?: number;
  }>,
): void => {
  const rows = agents.map((agent) => [
    agent.name,
    agent.status,
    agent.task ?? '',
    typeof agent.progress === 'number' ? `${Math.round(agent.progress)}%` : '',
  ]);
  publishPichamberUI(pi, {
    id: 'subagents',
    title: 'Sub-agents',
    component: 'table',
    props: { columns: ['Agent', 'Status', 'Task', 'Progress'], rows },
  });
};

/**
 * Register (or remove) a sandboxed app surface. The HTML renders inside an
 * iframe with script execution only: no same-origin access to PiChamber, no
 * cookies or storage, no navigation. The only capability granted back is
 * firing registered slash commands from elements carrying
 * `data-pichamber-command` / `data-pichamber-args`. Pass `{ removed: true }`
 * to unregister.
 *
 * ```ts
 * publishPichamberApp(pi, {
 *   appId: 'board',
 *   title: 'Kanban board',
 *   html: '<button data-pichamber-command="board-next">Next</button>',
 * });
 * ```
 */
export const publishPichamberApp = (
  pi: Pick<ExtensionApiLike, 'appendEntry'>,
  descriptor: { appId: string; title?: string; html?: string; removed?: boolean },
): void => {
  pi.appendEntry('pichamber.app', {
    protocol: PICHAMBER_UI_PROTOCOL,
    version: PICHAMBER_UI_VERSION,
    appId: descriptor.appId.slice(0, 128),
    ...(descriptor.removed ? { removed: true } : {}),
    ...(descriptor.title ? { title: descriptor.title.slice(0, 256) } : {}),
    ...(descriptor.html && !descriptor.removed ? { html: descriptor.html } : {}),
  });
};
