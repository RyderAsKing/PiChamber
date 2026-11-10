import type { PiSessionShelfEntry, PiSessionShelfInput } from '@/lib/pi/protocol';

/**
 * Sidebar shelf rules: which section a session belongs in (Pinned, active,
 * Working, Snoozed) and the snooze menu. The server stores only what the user
 * chose (`PiSessionShelfEntry`); everything time-based is derived here so
 * every client applies the same rule. Putting a session away for good is
 * Archive, which hides it from these views.
 */

export type SessionShelfSection = 'pinned' | 'active' | 'working' | 'snoozed';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Mirrors the server's write so an optimistic entry matches the stored one. */
export const applyShelfPatch = (
  entry: PiSessionShelfEntry | undefined,
  patch: Omit<PiSessionShelfInput, 'sessionId'>,
  now: number,
): PiSessionShelfEntry | undefined => {
  const next: PiSessionShelfEntry = { ...entry };
  if (Object.hasOwn(patch, 'snoozedUntil')) {
    delete next.snoozedUntil;
    delete next.snoozedAt;
    if (typeof patch.snoozedUntil === 'number') {
      next.snoozedUntil = patch.snoozedUntil;
      next.snoozedAt = now;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

export interface SessionShelfInput {
  entry: PiSessionShelfEntry | undefined;
  pinned: boolean;
  /** The agent is running (busy or retrying). */
  working: boolean;
  /** The session waits on the user (question, approval). */
  needsInput: boolean;
  /** Last message activity, ms epoch. */
  updatedAt: number;
  now: number;
}

/**
 * A snooze holds until its wake time. Only a request for the user ends it
 * early: a working snoozed session keeps working out of sight.
 */
const isSnoozed = (entry: PiSessionShelfEntry | undefined, now: number, needsInput: boolean): boolean =>
  typeof entry?.snoozedUntil === 'number' && entry.snoozedUntil > now && !needsInput;

/**
 * The snooze passed but the user has not opened the session since; the row
 * says it woke. Opening the session clears the stored wake.
 */
export const hasWokeFromSnooze = (entry: PiSessionShelfEntry | undefined, now: number): boolean =>
  typeof entry?.snoozedUntil === 'number' && entry.snoozedUntil <= now;

/** When the session last did something: its messages or a snooze wake. */
export const sessionActivityAt = (input: Pick<SessionShelfInput, 'entry' | 'updatedAt' | 'now'>): number => {
  const woke = hasWokeFromSnooze(input.entry, input.now) ? input.entry!.snoozedUntil! : 0;
  return Math.max(input.updatedAt, woke);
};

/**
 * Snoozed comes first, then Pinned, then the active list, whose working
 * sessions move to the Working shelf when it is enabled.
 */
export const resolveSessionShelfSection = (
  input: SessionShelfInput & { workingShelf: boolean },
): SessionShelfSection => {
  if (isSnoozed(input.entry, input.now, input.needsInput)) return 'snoozed';
  if (input.pinned) return 'pinned';
  if (input.workingShelf && input.working && !input.needsInput) return 'working';
  return 'active';
};

/** The soonest future snooze wake, so the sidebar can re-sort at that moment. */
export const nextSnoozeWakeAt = (entries: Record<string, PiSessionShelfEntry>, now: number): number | null => {
  let next: number | null = null;
  for (const entry of Object.values(entries)) {
    const wake = entry.snoozedUntil;
    if (typeof wake === 'number' && wake > now && (next === null || wake < next)) next = wake;
  }
  return next;
};

/* ------------------------------------------------------------------ */
/* Snooze menu                                                         */
/* ------------------------------------------------------------------ */

type SnoozePresetSetting =
  | { kind: 'after'; minutes: number }
  | { kind: 'at'; day: 'today' | 'tomorrow' | 'monday'; time: string };

const SNOOZE_PRESETS: readonly SnoozePresetSetting[] = [
  { kind: 'after', minutes: 60 },
  { kind: 'after', minutes: 180 },
  { kind: 'at', day: 'today', time: '18:00' },
  { kind: 'at', day: 'tomorrow', time: '09:00' },
  { kind: 'at', day: 'monday', time: '09:00' },
];

interface SnoozePreset {
  id: string;
  label: string;
  /** The wake time as shown beside the label ("6:00 PM", "Mon 9:00 AM"). */
  whenLabel: string;
  snoozedUntil: number;
}

const pluralize = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;

/** "3 hours", "90 minutes", "2 days": the largest unit that divides evenly. */
const formatSnoozeDuration = (minutes: number): string => {
  if (minutes % (24 * 60) === 0) return pluralize(minutes / (24 * 60), 'day');
  if (minutes % 60 === 0) return pluralize(minutes / 60, 'hour');
  return pluralize(minutes, 'minute');
};

const formatTimeOfDay = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const daysAheadFor = (day: 'today' | 'tomorrow' | 'monday', now: Date): number => {
  if (day === 'today') return 0;
  if (day === 'tomorrow') return 1;
  return (1 - now.getDay() + 7) % 7 || 7;
};

/** Labels follow the actual day gap, so the Monday option on a Sunday reads "Tomorrow". */
const presetLabel = (setting: SnoozePresetSetting, daysAhead: number): string => {
  if (setting.kind === 'after') return `In ${formatSnoozeDuration(setting.minutes)}`;
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12 ? 'This morning' : hour < 17 ? 'This afternoon' : 'This evening';
  }
  if (daysAhead === 1) return 'Tomorrow';
  return 'Next week';
};

const resolvePreset = (setting: SnoozePresetSetting, now: Date): SnoozePreset | null => {
  let wake: Date;
  let daysAhead = 0;
  if (setting.kind === 'after') {
    wake = new Date(now.getTime() + setting.minutes * 60_000);
  } else {
    daysAhead = daysAheadFor(setting.day, now);
    wake = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    // A today option whose time has passed is left out.
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = presetLabel(setting, daysAhead);
  const labelNamesDay = setting.kind === 'at' && label !== 'Next week';
  const time = formatTimeOfDay(wake);
  return {
    id: setting.kind === 'after' ? `after:${setting.minutes}` : `at:${setting.day}:${setting.time}`,
    label,
    whenLabel: labelNamesDay || wake.toDateString() === now.toDateString()
      ? time
      : `${wake.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`,
    snoozedUntil: wake.getTime(),
  };
};

/** The snooze menu: soonest first, one row per wake minute. */
export const resolveSnoozePresets = (now: Date): SnoozePreset[] => {
  const seen = new Set<number>();
  return SNOOZE_PRESETS
    .flatMap((setting) => resolvePreset(setting, now) ?? [])
    .sort((left, right) => left.snoozedUntil - right.snoozedUntil)
    .filter((preset) => {
      const minute = Math.floor(preset.snoozedUntil / 60_000);
      if (seen.has(minute)) return false;
      seen.add(minute);
      return true;
    });
};

/** "6:00 PM" today, "Tue" within a week, otherwise a short date. */
export const formatSnoozeWake = (snoozedUntil: number, now: number): string => {
  const wake = new Date(snoozedUntil);
  const today = new Date(now);
  const time = formatTimeOfDay(wake);
  if (wake.toDateString() === today.toDateString()) return time;
  // The row has room for one word; the exact time is in the row's tooltip.
  if (snoozedUntil - now < 6 * DAY_MS) return wake.toLocaleDateString(undefined, { weekday: 'short' });
  return wake.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
