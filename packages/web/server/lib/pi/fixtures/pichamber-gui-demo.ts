/**
 * Reference Pi extension that works in the plain Pi CLI and uses PiChamber's
 * extension API when it is there.
 *
 *   pi -e ./pichamber-gui-demo.ts
 *
 * Or drop it into `~/.pi/agent/extensions/`, or `.pi/extensions/` for one
 * project. `globalThis.pichamber` is undefined in the CLI, so every PiChamber
 * call below sits behind that one check and has a plain fallback.
 *
 * Types: `@pi-chamber/web/pichamber` (`pichamber.d.ts`).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { PiChamber } from '../../../../pichamber.js';

const pichamber = (globalThis as { pichamber?: PiChamber }).pichamber;

export default function (pi: ExtensionAPI): void {
  let plan = false;

  // A toggle in the composer. The extension keeps the value; a click runs
  // `/demo-plan`, which declares the control again with the new value.
  const declarePlan = (ctx: ExtensionContext) => pichamber?.control(ctx, {
    id: 'plan', kind: 'toggle', label: 'Plan', description: 'Plan before editing', value: plan, command: 'demo-plan',
  });
  pi.on('session_start', async (_event, ctx) => { await declarePlan(ctx); });
  pi.registerCommand('demo-plan', {
    description: 'Toggle plan mode',
    handler: async (_args, ctx) => {
      plan = !plan;
      await declarePlan(ctx);
      if (!pichamber) ctx.ui.notify(`Plan mode ${plan ? 'on' : 'off'}`, 'info');
    },
  });

  // A card in the chat with a button that runs `/demo-plan`.
  pi.registerCommand('demo-status', {
    description: 'Show the demo status',
    handler: async (_args, ctx) => {
      if (!pichamber) {
        ctx.ui.notify(`Plan mode is ${plan ? 'on' : 'off'}`, 'info');
        return;
      }
      await pichamber.card(ctx, {
        title: 'Demo status',
        component: 'kv',
        props: { rows: [{ label: 'Plan mode', value: plan ? 'On' : 'Off', tone: plan ? 'success' : 'neutral' }] },
        actions: [{ label: plan ? 'Turn plan off' : 'Turn plan on', command: 'demo-plan' }],
      });
    },
  });

  // A question with described choices, and a form; Pi's own dialogs otherwise.
  pi.registerCommand('demo-ask', {
    description: 'Ask a question',
    handler: async (_args, ctx) => {
      const sizes = [
        { id: 's', label: 'Small', description: 'One file' },
        { id: 'l', label: 'Large', description: 'The whole package' },
      ];
      let size: string | undefined;
      if (pichamber) {
        size = (await pichamber.choose(ctx, 'How big is the change?', sizes, { allowNote: true }))?.id;
      } else {
        const label = await ctx.ui.select('How big is the change?', sizes.map((choice) => choice.label));
        size = sizes.find((choice) => choice.label === label)?.id;
      }
      if (!size) return;
      const answers = pichamber
        ? await pichamber.form(ctx, 'Describe it', [
            { id: 'title', label: 'Title', required: true },
            { id: 'tests', label: 'Add tests', type: 'checkbox' },
          ])
        : { title: await ctx.ui.input('Title') ?? '' };
      if (answers?.title) ctx.ui.notify(`${size === 's' ? 'Small' : 'Large'} change: ${answers.title}`, 'info');
    },
  });
}
