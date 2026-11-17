import { describe, expect, test } from 'bun:test';

import { describePluginImpact, summarizePluginImpact } from './impact';

describe('describePluginImpact', () => {
  test('no agent half adds nothing', () => {
    expect(describePluginImpact(null)).toBe('Adds nothing to the agent.');
    expect(describePluginImpact({ tools: [], hooks: [], commands: [] })).toBe('Adds nothing to the agent.');
  });

  test('names tools, totals tokens, and flags prompt hooks', () => {
    expect(describePluginImpact({
      tools: [{ name: 'a', exposure: 'direct', tokens: 150 }, { name: 'b', exposure: 'direct', tokens: 1000 }],
      hooks: ['context'],
      commands: ['agents'],
    })).toBe(`Adds 2 tools (a, b), about ${(1150).toLocaleString()} tokens per request. Adds /agents. Can change the prompt or request before it is sent.`);
    expect(describePluginImpact({ tools: [{ name: 'render_html', exposure: 'direct', tokens: 210 }], hooks: [], commands: [] }))
      .toBe('Adds 1 tool (render_html), about 210 tokens per request.');
  });
});

describe('summarizePluginImpact', () => {
  test('no agent half adds nothing', () => {
    expect(summarizePluginImpact(null)).toBe('Adds nothing to the agent');
    expect(summarizePluginImpact({ tools: [], hooks: [], commands: [] })).toBe('Adds nothing to the agent');
  });

  test('counts tools and commands and totals tokens', () => {
    expect(summarizePluginImpact({ tools: [{ name: 'render_html', exposure: 'direct', tokens: 210 }], hooks: [], commands: [] }))
      .toBe('1 tool · about 210 tokens per request');
    expect(summarizePluginImpact({
      tools: [{ name: 'a', exposure: 'direct', tokens: 150 }, { name: 'b', exposure: 'direct', tokens: 1000 }],
      hooks: ['context'],
      commands: ['agents'],
    })).toBe(`2 tools · 1 command · changes requests · about ${(1150).toLocaleString()} tokens per request`);
  });
});
