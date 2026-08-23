import type { ToolPart } from '@/lib/chat/types';

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

export const getToolSkillName = (part: ToolPart): string | null => {
  const toolName = part.tool?.trim().toLowerCase();
  const state = part.state;
  const input = state?.input && typeof state.input === 'object'
    ? state.input as Record<string, unknown>
    : undefined;

  if (toolName === 'skill') {
    return nonEmptyString(input?.name);
  }
  if (toolName !== 'read') return null;

  const pichamber = state?.metadata?.pichamber;
  if (!pichamber || typeof pichamber !== 'object') return null;
  const skill = (pichamber as Record<string, unknown>).skill;
  if (!skill || typeof skill !== 'object') return null;
  return nonEmptyString((skill as Record<string, unknown>).name);
};
