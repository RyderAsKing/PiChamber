import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createImpactCache, estimateToolTokens, measurePluginImpact } from './impact.js';

const fixture = async (source) => {
  const dir = await mkdtemp(join(tmpdir(), 'pichamber-plugin-impact-'));
  const entry = join(dir, 'extension.js');
  await writeFile(entry, source);
  return {
    id: 'fixture',
    version: '1.0.0',
    entry,
    stateSchema: { on: { type: 'boolean', scope: 'global', default: true, label: 'On' } },
  };
};

describe('plugin impact', () => {
  it('records tools, prompt-affecting hooks and commands', async () => {
    const manifest = await fixture(`
      export default function (pi, pichamber) {
        if (pichamber.state().on !== true) throw new Error('defaults missing');
        pichamber.ui.choose({}, 'T', []).then(() => {});
        pi.registerTool({ name: 'a_tool', description: 'Does a.', parameters: { type: 'object' } });
        pi.registerTool({ name: 'b_tool', description: 'Does b.', parameters: { type: 'object' }, exposure: 'deferred' });
        pi.on('before_agent_start', () => {});
        pi.on('context', () => {});
        pi.on('session_start', () => {});
        pi.registerCommand('demo', { handler: () => {} });
        pi.registerMessageRenderer('x', () => null);
        pi.getActiveTools().includes('a_tool');
      }
    `);
    const { impact } = await measurePluginImpact(manifest);
    expect(impact).toEqual({
      tools: [
        { name: 'a_tool', exposure: 'direct', tokens: estimateToolTokens({ name: 'a_tool', description: 'Does a.', parameters: { type: 'object' } }) },
        { name: 'b_tool', exposure: 'deferred', tokens: expect.any(Number) },
      ],
      hooks: ['before_agent_start', 'context'],
      commands: ['demo'],
    });
  });

  it('estimates tokens as ceil(chars / 4) of the declaration JSON', () => {
    const tool = { name: 'x', description: 'y', parameters: { type: 'object' } };
    expect(estimateToolTokens(tool)).toBe(Math.ceil(JSON.stringify(tool).length / 4));
  });

  it('reports a throwing or invalid plugin as unmeasured', async () => {
    const throwing = await fixture('export default function () { throw new Error("boom"); }');
    await expect(measurePluginImpact(throwing)).resolves.toEqual({ impact: null, impactError: 'boom' });
    const noDefault = await fixture('export const x = 1;');
    await expect(measurePluginImpact(noDefault)).resolves.toMatchObject({ impact: null, impactError: expect.stringMatching(/default export/) });
    const hanging = await fixture('export default function () { return new Promise(() => {}); }');
    await expect(measurePluginImpact(hanging, { timeoutMs: 20 })).resolves.toMatchObject({ impact: null, impactError: expect.stringMatching(/timed out/) });
  });

  it('measures the bundled Visuals plugin', async () => {
    const entry = new URL('../../../plugins/visuals/extension.js', import.meta.url).pathname;
    const { impact } = await measurePluginImpact({ id: 'visuals', version: '1.0.0', entry, stateSchema: {} });
    expect(impact.tools).toEqual([
      { name: 'render_html', exposure: 'direct', tokens: expect.any(Number) },
      { name: 'render_choices', exposure: 'direct', tokens: expect.any(Number) },
    ]);
    expect(impact.tools[0].tokens).toBeLessThan(260);
    expect(impact.tools[1].tokens).toBeLessThan(400);
    expect(impact.hooks).toEqual([]);
    expect(impact.commands).toEqual([]);
  });

  it('caches per plugin id and version', async () => {
    const measure = vi.fn(async () => ({ impact: { tools: [], hooks: [], commands: [] } }));
    const cache = createImpactCache({ measure });
    await cache.get({ id: 'a', version: '1.0.0' });
    await cache.get({ id: 'a', version: '1.0.0' });
    await cache.get({ id: 'a', version: '1.0.1' });
    expect(measure).toHaveBeenCalledTimes(2);
  });
});
