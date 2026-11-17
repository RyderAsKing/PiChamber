import * as React from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { cn } from '@/lib/utils';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

/**
 * On/off switch for a setting that takes effect at once (a plugin, a
 * feature). Use `Checkbox` for options inside a form or a list of choices.
 * Only the thumb's `transform` animates.
 */
export const Switch = React.memo<SwitchProps>(function Switch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  className,
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(next) => onChange(Boolean(next))}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border outline-none',
        checked
          ? 'border-transparent bg-[var(--primary-base)]'
          : 'border-[var(--interactive-border-hover)] bg-[var(--interactive-hover)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full shadow-sm transition-transform duration-150 ease-out',
          checked ? 'translate-x-4 bg-[var(--primary-foreground)]' : 'translate-x-0.5 bg-[var(--surface-elevated)]',
        )}
      />
    </BaseSwitch.Root>
  );
});
