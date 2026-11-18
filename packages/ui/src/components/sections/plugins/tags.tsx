import React from 'react';

import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { cn } from '@/lib/utils';

/** A small label beside a name: where a plugin comes from, what kind of thing a row is. */
export function Tag({ children, title, className }: { children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 typography-micro font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The PiChamber mark at the size of a tag's text. */
function Mark() {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0">
      <PiChamberLogo width={12} height={12} />
    </span>
  );
}

/** On a plugin that ships with PiChamber. */
export function NativeTag() {
  return (
    <Tag title="Made for PiChamber and comes with it">
      <Mark />
      {'Native'}
    </Tag>
  );
}

/** On a package enhanced for PiChamber: built with the plugin SDK (it declares a `pichamber` block). */
export function PiChamberTag() {
  return (
    <Tag title="Enhanced for PiChamber: adds features only PiChamber shows. It works in the terminal too.">
      <Mark />
      {'Enhanced'}
    </Tag>
  );
}
