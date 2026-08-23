const FORK_PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

const hashString = (value: string): number => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
};

export const getForkColorIdForSession = (
  sessionId: string,
  parentById: ReadonlyMap<string, string | null>,
  childrenCountById: ReadonlyMap<string, number>,
): string | null => {
  if ((childrenCountById.get(sessionId) ?? 0) > 0) return sessionId;
  return parentById.get(sessionId) ?? null;
};

export const getForkColor = (sessionId: string | null | undefined): string | null => {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) return null;
  const index = hashString(sessionId.trim()) % FORK_PALETTE.length;
  return FORK_PALETTE[index];
};

export const getForkBackgroundColor = (
  sessionId: string | null | undefined,
  opts?: { active?: boolean; isMobile?: boolean },
): string | null => {
  const solid = getForkColor(sessionId);
  if (!solid) return null;
  if (opts?.isMobile) return null;
  if (opts?.active) {
    return `color-mix(in srgb, ${solid} 30%, var(--interactive-selection))`;
  }
  return `color-mix(in srgb, ${solid} 18%, transparent)`;
};
