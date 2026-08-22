const FORK_PALETTE = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
] as const;

const hashString = (value: string): number => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
};

export const getForkFamilyColor = (familyId: string | null | undefined): string | null => {
  if (!familyId || typeof familyId !== 'string' || familyId.trim().length === 0) return null;
  const index = hashString(familyId.trim()) % FORK_PALETTE.length;
  return FORK_PALETTE[index];
};

export const getForkFamilyIdForSession = (
  sessionId: string,
  parentById: ReadonlyMap<string, string | null>,
): string | null => {
  if (!sessionId) return null;
  let current: string | null | undefined = sessionId;
  const visited = new Set<string>();
  let root: string | null = null;
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const parent = parentById.get(current);
    if (!parent) {
      root = current;
      break;
    }
    current = parent;
  }
  return root;
};

export const FORK_PALETTE_FOR_TESTS = [...FORK_PALETTE];
