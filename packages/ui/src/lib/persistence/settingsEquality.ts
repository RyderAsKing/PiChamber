import type { DesktopSettings } from '@/lib/desktop';

export const areStringRecordsEqual = (
  left: Record<string, string>,
  right: Record<string, string>
): boolean => {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value]) => right[key] === value);
};

export const areCommandTriggerListsEqual = (
  left: NonNullable<DesktopSettings['commandTriggers']>,
  right: NonNullable<DesktopSettings['commandTriggers']>
): boolean =>
  left.length === right.length &&
  left.every((trigger, index) => {
    const other = right[index];
    return (
      Boolean(other) &&
      trigger.id === other?.id &&
      trigger.label === other.label &&
      trigger.command === other.command &&
      trigger.args === other.args &&
      trigger.combo === other.combo
    );
  });

export const areModelRefsEqual = (
  left: Array<{ providerID: string; modelID: string }>,
  right: Array<{ providerID: string; modelID: string }>
): boolean =>
  left.length === right.length &&
  left.every(
    (item, idx) =>
      item.providerID === right[idx]?.providerID &&
      item.modelID === right[idx]?.modelID
  );

export const areStringArraysEqual = (
  left: string[],
  right: string[]
): boolean =>
  left.length === right.length &&
  left.every((value, idx) => value === right[idx]);

export const areRecentEffortsEqual = (
  left: Record<string, string[]>,
  right: Record<string, string[]>
): boolean => {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Array.isArray(right[key]) && areStringArraysEqual(left[key], right[key])
  );
};
