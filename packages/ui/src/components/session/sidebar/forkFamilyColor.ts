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

export const hexToRgba = (hex: string, alpha: number): string => {
  const clean = hex.replace('#', '');
  const normalized = clean.length === 3
    ? clean.split('').map((ch) => ch + ch).join('')
    : clean;
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const FORK_BACKGROUND_ALPHA = 0.11;
const FORK_BACKGROUND_ACTIVE_ALPHA = 0.2;

export const getForkFamilyBackgroundColor = (
  familyId: string | null | undefined,
  opts?: { active?: boolean },
): string | null => {
  const solid = getForkFamilyColor(familyId);
  if (!solid) return null;
  const useActive = Boolean(opts?.active);
  // Prefer color-mix for a theme-aware translucent wash when available.
  // color-mix(in srgb, <solid> 13%, transparent) keeps the tint subtle
  // and works in both light/dark without hard-coded alpha shifts.
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    && CSS.supports('color', 'color-mix(in srgb, red 50%, blue)')) {
    if (useActive) return `color-mix(in srgb, ${solid} 26%, var(--interactive-selection))`;
    return `color-mix(in srgb, ${solid} 13%, transparent)`;
  }
  return hexToRgba(solid, useActive ? FORK_BACKGROUND_ACTIVE_ALPHA : FORK_BACKGROUND_ALPHA);
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
