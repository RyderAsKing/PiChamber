// A stable letter and color for a project that has no icon of its own, so
// folders stay distinguishable at a glance.

// Theme variables with distinct hues in every built-in theme; the same set the
// agent name colors draw from, so marks follow the active theme.
const PROJECT_MARK_COLORS = [
  'var(--syntax-keyword)',
  'var(--syntax-string)',
  'var(--syntax-number)',
  'var(--syntax-function)',
  'var(--syntax-type)',
  'var(--syntax-variable)',
  'var(--primary)',
] as const;

type ProjectMark = {
  text: string;
  color: string;
};

// The first letter or digit of the name; '?' when it has neither.
const markText = (label: string): string => {
  const first = label.normalize('NFKC').match(/[\p{L}\p{N}]/u)?.[0];
  return first ? first.toLocaleUpperCase() : '?';
};

const markColor = (label: string): string => {
  let hash = 0;
  for (const char of label.normalize('NFKC').trim().toLowerCase()) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return PROJECT_MARK_COLORS[hash % PROJECT_MARK_COLORS.length] ?? PROJECT_MARK_COLORS[0];
};

export const getProjectMark = (label: string): ProjectMark => ({
  text: markText(label),
  color: markColor(label),
});
