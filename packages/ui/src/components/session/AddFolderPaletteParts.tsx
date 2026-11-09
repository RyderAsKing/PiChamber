import React from 'react';
import { cn } from '@/lib/utils';

/** A key cap, as shown in the dialog's key hints and on its submit button. */
export const Kbd: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <kbd
    className={cn(
      'inline-flex h-4 min-w-4 normal-case items-center justify-center rounded border border-border bg-[var(--surface-muted)] px-1 font-sans typography-micro text-muted-foreground',
      className,
    )}
  >
    {children}
  </kbd>
);

export type KeyHint = { keys: string[]; label: string };

export const KeyHints: React.FC<{ hints: KeyHint[] }> = ({ hints }) => (
  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
    {hints.map((hint) => (
      <span key={hint.label} className="flex items-center gap-1">
        {hint.keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
        <span>{hint.label}</span>
      </span>
    ))}
  </span>
);

interface PaletteRowProps {
  id: string;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  ariaLabel?: string;
  ariaChecked?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * One row of the dialog's list. The path field keeps focus while rows are
 * picked with the arrow keys, so a row is an option the field points at, not
 * a focus stop. The highlight shows only while focus is in the dialog: on a
 * touch screen with the keyboard down it would read as a choice.
 */
export const PaletteRow = React.forwardRef<HTMLDivElement, PaletteRowProps>(
  ({ id, active, onSelect, onHover, ariaLabel, ariaChecked, className, children }, ref) => (
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
        active && 'group-focus-within/palette:bg-interactive-selection group-focus-within/palette:text-interactive-selection-foreground',
        !active && 'hover:bg-interactive-hover/60',
        className,
      )}
    >
      {children}
    </div>
  ),
);
PaletteRow.displayName = 'PaletteRow';
