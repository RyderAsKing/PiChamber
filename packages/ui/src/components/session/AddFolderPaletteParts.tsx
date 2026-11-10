import React from 'react';
import { cn } from '@/lib/utils';

interface PaletteRowProps {
  id: string;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  ariaLabel?: string;
  ariaChecked?: boolean;
  className?: string;
  /** A keyboard cursor rather than a choice: a light fill, so it never outranks the destination line. */
  quiet?: boolean;
  children: React.ReactNode;
}

/**
 * One row of the dialog's list. The path field keeps focus while rows are
 * picked with the arrow keys, so a row is an option the field points at, not
 * a focus stop. The highlight shows only while focus is in the dialog: on a
 * touch screen with the keyboard down it would read as a choice.
 */
export const PaletteRow = React.forwardRef<HTMLDivElement, PaletteRowProps>(
  ({ id, active, onSelect, onHover, ariaLabel, ariaChecked, className, quiet = false, children }, ref) => (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={active}
      aria-checked={ariaChecked}
      aria-label={ariaLabel}
      onMouseMove={active ? undefined : onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left typography-ui-label text-foreground',
        active && (quiet
          ? 'group-focus-within/palette:bg-interactive-hover'
          : 'group-focus-within/palette:bg-interactive-selection group-focus-within/palette:text-interactive-selection-foreground'),
        !active && 'hover:bg-interactive-hover/60',
        className,
      )}
    >
      {children}
    </div>
  ),
);
PaletteRow.displayName = 'PaletteRow';
