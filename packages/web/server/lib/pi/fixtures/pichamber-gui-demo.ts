/**
 * Reference pi extension that works in plain pi CLI via normal pi APIs and
 * optionally renders rich UI in PiChamber.
 *
 * Drop this file into `~/.pi/agent/extensions/pichamber-gui-demo.ts` to try it:
 *
 *   pi -e ./pichamber-gui-demo.ts
 *
 * Or place it under `.pi/extensions/` for a single project.
 *
 * PiChamber detection is optional and never required: the tool, commands,
 * and hooks work without PiChamber, and the `pichamber.ui` card degrades to a
 * generic JSON card in the CLI transcript.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

// Inline helpers keep the extension independent of PiChamber packages. Copy
// the same detection and descriptor shape into extensions that opt into the GUI.
const isPiChamber = (ctx: { mode: string; hasUI: boolean }): boolean => {
  const marker = (globalThis as unknown as Record<string, unknown>).__PICHAMBER__ as
    | { version?: number }
    | undefined;
  if (marker?.version) return true;
  try {
    if (typeof process !== 'undefined' && (process as unknown as { env?: Record<string, string> }).env?.PICHAMBER === '1') return true;
  } catch {}
  return ctx.mode === 'rpc' && ctx.hasUI === true;
};

const publishUi = (
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  payload: Record<string, unknown>,
) => {
  pi.appendEntry('pichamber.ui', {
    protocol: 'pichamber-extension-ui',
    version: 1,
    ...payload,
  });
};

const publishApp = (
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  payload: Record<string, unknown>,
) => {
  pi.appendEntry('pichamber.app', {
    protocol: 'pichamber-extension-ui',
    version: 1,
    ...payload,
  });
};

type SubagentRecord = {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  task: string;
};

export default function (pi: ExtensionAPI): void {
  // In-memory state owned by the extension. PiChamber mirrors the `subagents`
  // snapshot as a server-side normalized map (statuses/widgets) so a phone
  // that connects later sees the current list without the extension resending.
  const subagents = new Map<string, SubagentRecord>();
  let appVisible = false;

  const renderSubagents = () => {
    const agents = [...subagents.values()];
    if (agents.length === 0) {
      publishUi(pi, {
        id: 'pichamber-demo-subagents',
        title: 'Sub-agents',
        component: 'markdown',
        props: { body: '_No sub-agents running._' },
      });
      return;
    }

    publishUi(pi, {
      id: 'pichamber-demo-subagents',
      title: 'Sub-agents',
      component: 'table',
      props: {
        columns: ['Agent', 'Status', 'Task'],
        rows: agents.map((agent) => [agent.name, agent.status, agent.task]),
      },
      actions: [
        { label: 'Clear finished', command: 'pichamber-demo-clear', variant: 'ghost' as const },
        { label: 'Spawn…', command: 'pichamber-demo-spawn', promptForArgs: { label: 'Agent name' } },
      ],
    });
  };

  // Standard pi tool: callable by the model from any host.
  pi.registerTool({
    name: 'pichamber_demo_spawn',
    label: 'Demo: spawn sub-agent',
    description: 'Demo tool that pretends to spawn a sub-agent and publishes PiChamber GUI state.',
    parameters: Type.Object({
      name: Type.String({ description: 'Sub-agent name' }),
      task: Type.String({ description: 'Task description' }),
    }),
    async execute(_toolCallId, params) {
      const id = `agent-${Date.now().toString(36)}`;
      subagents.set(id, { id, name: params.name, status: 'running', task: params.task });

      // Optional PiChamber enhancement: publish a table that updates in place
      // (same `id` replaces the previous card; transcript history stays as fallback).
      renderSubagents();

      // Simulate async completion without actually spawning work, so the demo
      // remains useful without credentials or side effects.
      setTimeout(() => {
        const existing = subagents.get(id);
        if (existing) {
          existing.status = 'done';
          renderSubagents();
        }
      }, 800).unref?.();

      return {
        content: [{ type: 'text', text: `Spawned demo sub-agent "${params.name}" (${id}) for: ${params.task}` }],
        details: { subagentId: id, name: params.name, task: params.task },
      };
    },
  });

  // Standard slash commands: discoverable via `extensions.list` and invokable
  // through PiChamber's prompt path (action buttons also use this path).
  pi.registerCommand('pichamber-demo-subagents', {
    description: 'Show demo sub-agents',
    handler: async (_args, ctx) => {
      if (isPiChamber(ctx)) {
        renderSubagents();
        ctx.ui.notify(`Demo sub-agents: ${subagents.size} tracked`, 'info');
        return;
      }
      // CLI fallback: plain notification, no PiChamber card needed.
      ctx.ui.notify(`Demo sub-agents (${subagents.size}): ${[...subagents.values()].map((agent) => `${agent.name}:${agent.status}`).join(', ') || 'none'}`, 'info');
    },
  });

  pi.registerCommand('pichamber-demo-clear', {
    description: 'Clear finished demo sub-agents',
    handler: async (_args, ctx) => {
      for (const [id, agent] of subagents) {
        if (agent.status === 'done') subagents.delete(id);
      }
      if (isPiChamber(ctx)) renderSubagents();
      ctx.ui.notify('Cleared finished demo sub-agents', 'info');
    },
  });

  pi.registerCommand('pichamber-demo-progress', {
    description: 'Show a progress demo card',
    handler: async (args) => {
      const value = Math.max(0, Math.min(100, Number(args) || 40));
      publishUi(pi, {
        id: 'pichamber-demo-progress',
        title: 'Demo progress',
        component: 'progress',
        props: { label: 'Indexing', value, max: 100 },
        actions: [{ label: 'Reset', command: 'pichamber-demo-progress', args: '0' }],
      });
    },
  });

  // Structured multi-input dialog. PiChamber renders a native form and
  // resolves with a values object; plain pi falls back to sequential prompts.
  type FormCtx = Parameters<NonNullable<Parameters<ExtensionAPI['registerCommand']>[1]['handler']>>[1];
  const askAgent = async (ctx: FormCtx): Promise<{ name: string; task: string } | undefined> => {
    if (isPiChamber(ctx)) {
      const uiWithForm = ctx.ui as typeof ctx.ui & {
        form?: (title: string, fields: Array<Record<string, unknown>>, opts?: Record<string, unknown>) => Promise<Record<string, string> | undefined>;
      };
      if (typeof uiWithForm.form === 'function') {
        const values = await uiWithForm.form('Spawn sub-agent', [
          { id: 'name', label: 'Name', type: 'text', required: true, placeholder: 'research' },
          { id: 'task', label: 'Task', type: 'textarea', required: true },
          { id: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high'], initial: 'normal' },
        ]);
        if (!values?.name || !values.task) return undefined;
        return { name: values.name, task: values.task };
      }
    }
    const name = await ctx.ui.input('Sub-agent name');
    if (!name) return undefined;
    const task = await ctx.ui.input('Task description');
    if (!task) return undefined;
    return { name, task };
  };

  pi.registerCommand('pichamber-demo-spawn', {
    description: 'Spawn a demo sub-agent interactively (form dialog in PiChamber)',
    handler: async (args, ctx) => {
      let name = args?.trim() ?? '';
      let task = name ? `demo task for ${name}` : '';
      if (!name) {
        const answers = await askAgent(ctx);
        if (!answers) return;
        ({ name, task } = answers);
      }
      const id = `agent-${Date.now().toString(36)}`;
      subagents.set(id, { id, name, status: 'running', task });
      renderSubagents();
      ctx.ui.notify(`Spawned ${name}`, 'info');
    },
  });

  // Sandboxed app surface: self-contained HTML rendered in an iframe that can
  // only invoke registered commands through data-pichamber-command buttons.
  pi.registerCommand('pichamber-demo-app', {
    description: 'Toggle a sandboxed demo app surface (PiChamber only)',
    handler: async (_args, ctx) => {
      if (!isPiChamber(ctx)) {
        ctx.ui.notify('App surfaces are a PiChamber feature', 'warning');
        return;
      }
      if (appVisible) {
        publishApp(pi, { appId: 'demo-board', removed: true });
        appVisible = false;
        return;
      }
      publishApp(pi, {
        appId: 'demo-board',
        title: 'Demo board',
        html: `<!doctype html><html><body style="font-family:system-ui;padding:12px">
          <h3 style="margin:0 0 8px">Demo board</h3>
          <button data-pichamber-command="pichamber-demo-subagents">Refresh panel</button>
          <button data-pichamber-command="pichamber-demo-clear">Clear finished</button>
          <p style="color:#666">Buttons fire slash commands through PiChamber's authenticated prompt path.</p>
        </body></html>`,
      });
      appVisible = true;
    },
  });

  // Lifecycle hooks run identically inside PiChamber and plain pi. They do not
  // need PiChamber-specific branching, but can optionally publish UI when that
  // capability is present.
  pi.on('session_start', async (_event, ctx) => {
    if (isPiChamber(ctx)) {
      ctx.ui.setStatus('pichamber-demo', 'Demo extension active');
    }
  });

  pi.on('session_shutdown', async () => {
    subagents.clear();
  });
}
