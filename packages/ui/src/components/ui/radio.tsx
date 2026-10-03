import React from 'react';
import { cn } from '@/lib/utils';

interface RadioProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  /**
   * Draw the dot only: the enclosing element is the radio, so this one leaves the tab order and the accessibility tree.
   * It renders as a span, not a button, so touch layouts don't give it a button's touch-target size (see mobile.css).
   */
  decorative?: boolean;
  className?: string;
  iconClassName?: string;
}

export const Radio = React.memo<RadioProps>(function Radio({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  decorative = false,
  className,
  iconClassName,
}) {
  const handleClick = React.useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled && !checked) {
        onChange();
      }
    },
    [checked, disabled, onChange]
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!disabled && !checked) {
          onChange();
        }
      }
    },
    [checked, disabled, onChange]
  );

  const dot = (
    <span
      aria-hidden
      className={cn(
        'block h-[5px] w-[5px] rounded-full bg-white',
        !checked && 'opacity-0',
        iconClassName,
      )}
    />
  );
  const fillClassName = cn(
    'relative flex h-[14px] w-[14px] min-h-[14px] min-w-[14px] shrink-0 self-center items-center justify-center rounded-full',
    'transition-[background-color,box-shadow] duration-200 ease-out',
    // fill driven from props so first paint is correct
    checked
      ? 'bg-[color-mix(in_srgb,var(--primary-base)_80%,transparent)] shadow-none'
      : 'bg-[var(--surface-muted)] shadow-[inset_0_0_0_1px_var(--interactive-border)]',
  );

  if (decorative) {
    return (
      <span aria-hidden className={cn(fillClassName, disabled && 'opacity-50', className)}>
        {dot}
      </span>
    );
  }

  return (
    <button
      type="button"
      role="radio"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      aria-checked={checked}
      aria-label={ariaLabel}
      className={cn(
        'group/radio outline-none',
        fillClassName,
        checked ? 'hover:bg-[var(--primary-base)]' : 'hover:bg-[var(--interactive-hover)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {dot}
    </button>
  );
});
