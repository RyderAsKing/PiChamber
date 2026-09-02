import React, { useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { GitmojiEntry } from '@/hooks/useGitmojiList';

export interface GitmojiPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gitmojis: GitmojiEntry[];
  onSelect: (emoji: string, code: string) => void;
}

export const GitmojiPickerDialog = React.memo<GitmojiPickerDialogProps>(function GitmojiPickerDialog({
  open,
  onOpenChange,
  gitmojis,
  onSelect,
}) {
  const [search, setSearch] = useState('');

  const filtered = React.useMemo(() => {
    if (gitmojis.length === 0) return [];
    const term = search.trim().toLowerCase();
    if (!term) return gitmojis;
    return gitmojis.filter((entry) => (
      entry.emoji.includes(term) ||
      entry.code.toLowerCase().includes(term) ||
      entry.description.toLowerCase().includes(term)
    ));
  }, [gitmojis, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>{"Insert gitmoji"}</DialogTitle>
        </DialogHeader>
        <Command className="h-[420px]">
          <CommandInput
            placeholder={"Search gitmoji..."}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{"No gitmoji found"}</CommandEmpty>
            <CommandGroup>
              {filtered.map((entry) => (
                <CommandItem
                  key={entry.code}
                  onSelect={() => onSelect(entry.emoji, entry.code)}
                >
                  <span className="text-lg">{entry.emoji}</span>
                  <span className="typography-ui-label text-foreground">{entry.code}</span>
                  <span className="typography-meta text-muted-foreground">{entry.description}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
});
