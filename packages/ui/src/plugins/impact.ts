import type { PiPluginImpact } from '@/lib/pi/protocol';

const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

/** One plain sentence about what an enabled plugin adds to the agent. */
export const describePluginImpact = (impact: PiPluginImpact | null): string => {
  if (!impact) return 'Adds nothing to the agent.';
  const parts: string[] = [];
  if (impact.tools.length > 0) {
    const tokens = impact.tools.reduce((sum, tool) => sum + tool.tokens, 0);
    const names = impact.tools.map((tool) => tool.name).join(', ');
    parts.push(`Adds ${plural(impact.tools.length, 'tool', 'tools')} (${names}), about ${tokens.toLocaleString()} tokens per request.`);
  }
  if (impact.commands.length > 0) {
    parts.push(`Adds ${impact.commands.map((name) => `/${name}`).join(', ')}.`);
  }
  if (impact.hooks.length > 0) {
    parts.push('Can change the prompt or request before it is sent.');
  }
  return parts.length > 0 ? parts.join(' ') : 'Adds nothing to the agent.';
};

/** A short line for a plugin list: "1 tool · about 199 tokens per request". */
export const summarizePluginImpact = (impact: PiPluginImpact | null): string => {
  if (!impact || (impact.tools.length === 0 && impact.commands.length === 0 && impact.hooks.length === 0)) {
    return 'Adds nothing to the agent';
  }
  const parts: string[] = [];
  if (impact.tools.length > 0) parts.push(plural(impact.tools.length, 'tool', 'tools'));
  if (impact.commands.length > 0) parts.push(plural(impact.commands.length, 'command', 'commands'));
  if (impact.hooks.length > 0) parts.push('changes requests');
  const tokens = impact.tools.reduce((sum, tool) => sum + tool.tokens, 0);
  if (tokens > 0) parts.push(`about ${tokens.toLocaleString()} tokens per request`);
  return parts.join(' · ');
};
