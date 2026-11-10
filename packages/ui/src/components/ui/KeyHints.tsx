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

/** With `onSelect` the hint is also a button, so a pointer can do what the key does. */
export type KeyHint = { keys: string[]; label: string; onSelect?: () => void };

export const KeyHints: React.FC<{ hints: KeyHint[] }> = ({ hints }) => (
  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
    {hints.map((hint) => {
      const content = (
        <>
          {hint.keys.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
          <span>{hint.label}</span>
        </>
      );
      return hint.onSelect ? (
        <button
          key={hint.label}
          type="button"
          onClick={hint.onSelect}
          className="-mx-1 flex items-center gap-1 rounded px-1 transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          {content}
        </button>
      ) : (
        <span key={hint.label} className="flex items-center gap-1">
          {content}
        </span>
      );
    })}
  </span>
);
