/**
 * Every section the work-status panel can render, in display order.
 *
 * One list drives both the panel and its settings dialog, so a section cannot
 * exist in the panel without being switchable, or appear in the dialog without
 * existing.
 *
 * The ids are persisted in user settings — renaming one silently resets that
 * user's choice for it.
 */
export const WORK_STATUS_SECTION_IDS = [
  'session',
  'repository',
  'subagents',
  'tasks',
  'pinned',
  'contextSources',
] as const;

type WorkStatusSectionId = (typeof WORK_STATUS_SECTION_IDS)[number];

export const WORK_STATUS_SECTION_LABELS: Record<WorkStatusSectionId, string> = {
  session: "Session",
  repository: "Repository",
  subagents: "Subagents",
  tasks: "Tasks",
  pinned: "Pinned messages",
  contextSources: "Context sources",
};

const KNOWN_IDS = new Set<string>(WORK_STATUS_SECTION_IDS);

const isWorkStatusSectionId = (value: unknown): value is WorkStatusSectionId =>
  typeof value === 'string' && KNOWN_IDS.has(value);

/**
 * Hidden sections are stored, not visible ones: everything is on by default, so
 * an empty list means "the user has changed nothing" and a section added later
 * appears without touching anyone's saved settings.
 */
export const isWorkStatusSectionVisible = (
  hidden: readonly string[] | null | undefined,
  id: WorkStatusSectionId,
): boolean => !hidden?.includes(id);

export const sanitizeWorkStatusHiddenSections = (value: unknown): WorkStatusSectionId[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<WorkStatusSectionId>();
  for (const entry of value) {
    if (isWorkStatusSectionId(entry)) seen.add(entry);
  }
  return [...seen];
};
