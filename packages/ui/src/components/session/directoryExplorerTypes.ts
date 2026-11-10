import React from 'react';
import { getFilesystemHome } from '@/lib/fsApi';

export interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export type BrowseEntry = {
  name: string;
  path: string;
};

/** A row in a folder listing. `target` is the path field's value after opening it. */
export type BrowseRow = {
  type: 'parent' | 'directory';
  value: string;
  name: string;
  path: string;
  target: string;
  alreadyAdded: boolean;
};

const isApplePlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const isPrimaryModifierPressed = (event: React.KeyboardEvent<HTMLElement>): boolean => (
  isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
);

/** The key that, with Enter, finishes the dialog: ⌘ on Apple platforms, Ctrl elsewhere. */
export const primaryModifierLabel = (): string => (isApplePlatform() ? '⌘' : 'Ctrl');

export const focusPathInput = (input: HTMLInputElement | null): void => {
  if (!input) return;
  input.focus({ preventScroll: true });
  const valueLength = input.value.length;
  input.setSelectionRange(valueLength, valueLength);
  input.scrollLeft = input.scrollWidth;
};

export const resolveFreshFilesystemHome = async (): Promise<string | null> => {
  // Explicitly fresh: bypasses the runtime-scoped home memo in fsApi so the
  // directory explorer always re-reads the live server value on open.
  return getFilesystemHome({ fresh: true });
};
