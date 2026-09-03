import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { Snippet } from '@/types/snippet';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';

export interface SnippetAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

interface SnippetAutocompleteProps {
  searchQuery: string;
  onSnippetSelect: (snippet: Snippet, trigger: string) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

function snippetPreview(snippet: Snippet): string {
  const preview = (snippet.description || snippet.content).replace(/\s+/g, ' ').trim();
  return preview.length > 140 ? `${preview.slice(0, 140).trimEnd()}…` : preview;
}

export const SnippetAutocomplete = React.forwardRef<SnippetAutocompleteHandle, SnippetAutocompleteProps>(({
  searchQuery,
  onSnippetSelect,
  onClose,
  style,
}, ref) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const isMobile = useUIStore((state) => state.isMobile);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const [filteredSnippets, setFilteredSnippets] = React.useState<Snippet[]>([]);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const snippets = useSnippetsStore((s) => s.snippets);
  const loadSnippets = useSnippetsStore((s) => s.loadSnippets);
  const setSnippetDraft = useSnippetsStore((s) => s.setSnippetDraft);
  const setSelectedSnippet = useSnippetsStore((s) => s.setSelectedSnippet);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((s) => s.setSettingsPage);

  React.useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);

  React.useEffect(() => {
    const query = searchQuery.trim();
    const matches = query.length
      ? snippets.filter((snippet) => fuzzyMatch(snippet.name, query) || snippet.aliases.some((alias) => fuzzyMatch(alias, query)))
      : snippets;
    const sortedMatches = [...matches].sort((a, b) => {
      if (a.source === 'project' && b.source !== 'project') return -1;
      if (a.source !== 'project' && b.source === 'project') return 1;
      return a.name.localeCompare(b.name);
    });
    setFilteredSnippets(sortedMatches);
    setSelectedIndex(sortedMatches.length ? 1 : 0);
  }, [searchQuery, snippets]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  const chooseSnippet = React.useCallback((snippet: Snippet) => {
    const query = searchQuery.trim();
    const trigger = snippet.aliases.includes(query) ? query : snippet.name;
    onSnippetSelect(snippet, trigger);
  }, [onSnippetSelect, searchQuery]);

  const openNewSnippetSettings = React.useCallback(() => {
    const existing = new Set(snippets.map((snippet) => snippet.name));
    let name = 'new-snippet';
    let counter = 1;
    while (existing.has(name)) {
      name = `new-snippet-${counter++}`;
    }
    setSnippetDraft({ name, scope: 'global' });
    setSelectedSnippet(name);
    setSettingsPage('snippets');
    setSettingsDialogOpen(true);
    onClose();
  }, [onClose, setSelectedSnippet, setSettingsDialogOpen, setSettingsPage, setSnippetDraft, snippets]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }
      const itemCount = filteredSnippets.length + 1;
      if (key === 'ArrowDown') {
        setSelectedIndex((prev) => (prev + 1) % itemCount);
        return;
      }
      if (key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + itemCount) % itemCount);
        return;
      }
      if (key === 'Enter' || key === 'Tab') {
        if (selectedIndexRef.current === 0) {
          openNewSnippetSettings();
          return;
        }
        const snippet = filteredSnippets[selectedIndexRef.current - 1];
        if (snippet) chooseSnippet(snippet);
      }
    },
  }), [chooseSnippet, filteredSnippets, onClose, openNewSnippetSettings]);

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label="Snippets"
      aria-activedescendant={selectedIndex === 0 ? 'snippet-option-new' : `snippet-option-${selectedIndex}`}
      className="absolute bottom-full left-0 z-[100] flex max-h-80 min-w-0 w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-lg"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-1 py-1.5">
        <div
          id="snippet-option-new"
          ref={(el) => { itemRefs.current[0] = el; }}
          role="option"
          aria-selected={selectedIndex === 0}
          className={cn(
            'flex min-h-14 cursor-pointer items-start rounded-lg px-3 py-2.5',
            selectedIndex === 0
              ? 'bg-interactive-selection text-interactive-selection-foreground'
              : 'text-foreground hover:bg-interactive-hover',
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openNewSnippetSettings}
          onMouseMove={() => setSelectedIndex(0)}
        >
          <div className="min-w-0 flex-1">
            <div className="typography-ui-label font-medium">Create a new snippet</div>
            <div className={cn(
              'mt-1 text-xs leading-5',
              selectedIndex === 0 ? 'text-interactive-selection-foreground/75' : 'text-muted-foreground',
            )}>
              Save a reusable prompt template
            </div>
          </div>
        </div>
        {filteredSnippets.length ? filteredSnippets.map((snippet, index) => {
          const optionIndex = index + 1;
          const isSelected = optionIndex === selectedIndex;
          const sourceLabel = snippet.source === 'project' ? 'Project' : 'Global';
          const preview = snippetPreview(snippet);
          return (
            <div
              key={`${snippet.source}:${snippet.filePath}`}
              id={`snippet-option-${optionIndex}`}
              ref={(el) => { itemRefs.current[optionIndex] = el; }}
              role="option"
              aria-selected={isSelected}
              className={cn(
                'flex min-h-14 cursor-pointer items-start rounded-lg px-3 py-2.5',
                isSelected
                  ? 'bg-interactive-selection text-interactive-selection-foreground'
                  : 'text-foreground hover:bg-interactive-hover',
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseSnippet(snippet)}
              onMouseMove={() => setSelectedIndex(optionIndex)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-mono typography-ui-label font-medium">#{snippet.name}</span>
                  <span className={cn(
                    'ml-auto shrink-0 text-xs leading-4',
                    isSelected ? 'text-interactive-selection-foreground/75' : 'text-muted-foreground',
                  )}>
                    {sourceLabel}
                  </span>
                </div>
                {preview ? (
                  <div className={cn(
                    'mt-1 truncate text-xs leading-5',
                    isSelected ? 'text-interactive-selection-foreground/75' : 'text-muted-foreground',
                  )}>
                    {preview}
                  </div>
                ) : null}
              </div>
            </div>
          );
        }) : (
          <div className="px-3 py-4 typography-ui-label text-muted-foreground">No snippets found</div>
        )}
      </ScrollableOverlay>
      {!isMobile && (
        <div className="border-t border-border/60 px-3 py-2 text-xs leading-4 text-muted-foreground">
          ↑↓ Navigate · Enter Select · Esc Close
        </div>
      )}
    </div>
  );
});

SnippetAutocomplete.displayName = 'SnippetAutocomplete';
