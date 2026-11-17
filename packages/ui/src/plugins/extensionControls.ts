import type { PiComposerControl } from '@/lib/pi/protocol';

/**
 * Composer controls a Pi extension declares by emitting `pichamber:composer`
 * (see the session daemon's `extension-controls.js`). The extension owns the
 * value; a click asks the daemon to run the command for the value the user
 * picked, and the new value arrives as an `extension.control` event.
 */

/** A toggle's or cycle's value; an action has none. */
export type ControlValue = boolean | string | undefined;

/** The value a control shows: the one on its way while a click lands, else the extension's own. */
export const shownControlValue = (control: PiComposerControl, pending: ControlValue): ControlValue => {
  if (control.kind === 'action') return undefined;
  return pending !== undefined ? pending : control.value;
};

/**
 * The value a click asks for: a toggle flips, a cycle moves to the option
 * after the shown one (the first when none is shown, wrapping after the
 * last), an action asks for nothing.
 */
export const nextControlValue = (control: PiComposerControl, shown: ControlValue): ControlValue => {
  if (control.kind === 'toggle') return shown !== true;
  if (control.kind === 'action') return undefined;
  const index = control.options.findIndex((option) => option.value === shown);
  return control.options[(index + 1) % control.options.length]?.value;
};

/** The label of a cycle's option, or undefined for an unknown value. */
const cycleOptionLabel = (control: PiComposerControl, value: ControlValue): string | undefined => (
  control.kind === 'cycle' ? control.options.find((option) => option.value === value)?.label : undefined
);

/** What the pill reads: a cycle's current option (its own label until one is known), else the control's label. */
export const controlPillText = (control: PiComposerControl, shown: ControlValue): string => (
  cycleOptionLabel(control, shown) ?? control.label
);

/** The accessible name: `Mode: Balance` for a cycle, the label otherwise (a toggle adds `aria-pressed`). */
export const controlAccessibleName = (control: PiComposerControl, shown: ControlValue): string => {
  const option = cycleOptionLabel(control, shown);
  return option ? `${control.label}: ${option}` : control.label;
};

/** The tooltip's second line: what a click does. */
export const controlHintText = (control: PiComposerControl, shown: ControlValue): string => {
  if (control.kind === 'toggle') return shown === true ? 'On. Click to turn off' : 'Off. Click to turn on';
  if (control.kind === 'action') return `Runs /${control.command}`;
  const next = cycleOptionLabel(control, nextControlValue(control, shown));
  return next ? `Next: ${next}` : '';
};

/** True when the extension's value has caught up with the one a click asked for. */
export const controlSettled = (control: PiComposerControl | undefined, pending: ControlValue): boolean => (
  !control || control.kind === 'action' || control.value === pending
);

/** Same controls in the same order with the same content: a snapshot rerender needs nothing new. */
export const sameControls = (a: readonly PiComposerControl[], b: readonly PiComposerControl[]): boolean => (
  a.length === b.length && a.every((control, index) => control === b[index])
);
