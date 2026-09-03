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

export type BrowseRow =
  | { type: 'parent'; value: 'browse:up'; name: string; path: string; alreadyAdded: boolean }
  | { type: 'directory'; value: string; name: string; path: string; alreadyAdded: boolean };

export const isPrimaryModifierPressed = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

export const focusPathInput = (input: HTMLInputElement | null): void => {
  if (!input) return;
  input.focus({ preventScroll: true });
  const valueLength = input.value.length;
  input.setSelectionRange(valueLength, valueLength);
  input.scrollLeft = input.scrollWidth;
};

export const resolveFreshFilesystemHome = async (): Promise<string | null> => {
  return getFilesystemHome();
};
