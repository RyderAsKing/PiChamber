import React from 'react';
import { cn } from '@/lib/utils';

/** A key cap, as shown in a palette's key hints and on its buttons. */
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
