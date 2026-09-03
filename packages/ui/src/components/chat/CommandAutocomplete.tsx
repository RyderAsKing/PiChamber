import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessages } from '@/sync/sync-context';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import {
  commandMatchesCategory,
  commandMatchesSearch,
  mergeCommandAutocompleteItems,
  type CommandAutocompleteCategory,
} from './commandAutocompleteItems';
import { piClient } from '@/lib/pi/client';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';

type CommandSource = 'pichamber' | 'pi' | 'skill' | 'extension';

export interface CommandInfo {
  id: string;
  name: string;
  source: CommandSource;
  description?: string;
  searchAliases?: string[];
  agent?: string;
  model?: string;
  isBuiltIn?: boolean;
  isSkill?: boolean;
  scope?: string;
}

export interface CommandAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

const getCommandContext = (command: CommandInfo): string | null => {
  const primaryContext = command.isSkill
    ? 'Skill'
    : command.source === 'extension'
      ? 'Extension'
      : command.isBuiltIn
        ? 'Built-in'
        : command.scope;
  const labels = [primaryContext, command.agent].filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(' · ') : null;
};

const COMMAND_CATEGORY_OPTIONS: ReadonlyArray<{
  value: CommandAutocompleteCategory;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'system', label: 'System' },
  { value: 'skills', label: 'Skills' },
  { value: 'extensions', label: 'Extensions' },
];

interface CommandAutocompleteProps {
  searchQuery: string;
  onCommandSelect: (command: CommandInfo) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

const buildBuiltInCommands = (options: {
  hasSession: boolean;
  hasMessagesInCurrentSession: boolean;
}): CommandInfo[] => {
  const { hasSession, hasMessagesInCurrentSession } = options;
  return [
    ...(hasSession && !hasMessagesInCurrentSession
      ? [{ id: 'pichamber:init', name: 'init', source: 'pichamber' as const, description: "Create/update AGENTS.md file", isBuiltIn: true }]
      : []
    ),
    ...(hasSession
      ? [
          { id: 'pichamber:undo', name: 'undo', source: 'pichamber' as const, description: "Undo the last message", isBuiltIn: true },
          { id: 'pichamber:redo', name: 'redo', source: 'pichamber' as const, description: "Redo previously undone messages", isBuiltIn: true },
          { id: 'pichamber:timeline', name: 'timeline', source: 'pichamber' as const, description: "Open the conversation timeline", isBuiltIn: true },
        ]
      : []
    ),
    { id: 'pichamber:compact', name: 'compact', source: 'pichamber' as const, description: "Compress session history using AI to reduce context size", isBuiltIn: true },
  ];
};

export const CommandAutocomplete = React.forwardRef<CommandAutocompleteHandle, CommandAutocompleteProps>(({
  searchQuery,
  onCommandSelect,
  onClose,
  style,
}, ref) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionMessages = useSessionMessages(currentSessionId ?? '');
  const hasMessagesInCurrentSession = sessionMessages.length > 0;
  const hasSession = Boolean(currentSessionId);
  const extensionCatalogRevision = usePiSessionSnapshot(
    (state) => currentSessionId ? state.reducer.bySession.get(currentSessionId)?.extensionCatalogRevision ?? 0 : 0,
    Object.is,
    currentSessionId ? `session:${currentSessionId}` : 'chrome',
  );
  const isMobile = useUIStore((state) => state.isMobile);

  const [commands, setCommands] = React.useState<CommandInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [category, setCategory] = React.useState<CommandAutocompleteCategory>('all');
  const skills = useSkillsStore((s) => s.skills);
  const refreshSkills = useSkillsStore((s) => s.loadSkills);
  const effectiveDirectory = useEffectiveDirectory();

  // Extension-registered slash commands (pi extensions loaded by the session
  // daemon). Fetched per effective directory and cached in component state;
  // failures keep whatever was last known rather than emptying the list.
  const [extensionCommands, setExtensionCommands] = React.useState<CommandInfo[]>([]);
  React.useEffect(() => {
    if (!hasSession || !effectiveDirectory) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await piClient.listExtensions(effectiveDirectory);
        if (cancelled) return;
        setExtensionCommands((result.commands ?? [])
          .filter((command) => command.source === 'extension')
          .map((command, index) => ({
            id: `extension:${command.name}:${index}`,
            name: command.name,
            source: 'extension' as const,
            description: command.description,
          })));
      } catch {
        // Autocomplete still works with built-ins; extension commands are a
        // progressive enhancement, not an authoritative fetch.
      }
    })();
    return () => { cancelled = true; };
  }, [hasSession, effectiveDirectory, extensionCatalogRevision]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const keyboardNavigationRef = React.useRef(false);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const ignoreClickRef = React.useRef(false);
  const pointerStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const pointerMovedRef = React.useRef(false);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) {
        return;
      }
      if (containerRef.current.contains(target)) {
        return;
      }
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  React.useEffect(() => {
    // Force refresh to get latest project context when mounting
    void refreshSkills();
  }, [refreshSkills]);

  React.useEffect(() => {
    const loadCommands = async () => {
      setLoading(true);
      try {
        const skillCommands: CommandInfo[] = skills.map((skill, index) => ({
          id: `skill:${skill.scope}:${skill.source ?? 'pi'}:${skill.name}:${index}`,
          name: skill.name,
          source: 'skill',
          description: skill.description,
          isSkill: true,
          scope: skill.scope,
        }));

        const builtInCommands = buildBuiltInCommands({ hasSession, hasMessagesInCurrentSession });
        const allCommands = mergeCommandAutocompleteItems(builtInCommands, [], skillCommands);
        const builtInNames = new Set(allCommands.map((cmd) => cmd.name));
        const withExtensions = [...allCommands, ...extensionCommands.filter((cmd) => !builtInNames.has(cmd.name))];

        const allowInitCommand = !hasMessagesInCurrentSession;
        const categorized = withExtensions.filter((cmd) => commandMatchesCategory(cmd, category));
        const filtered = (searchQuery
          ? categorized.filter(cmd => commandMatchesSearch(cmd, searchQuery))
          : categorized).filter(cmd => allowInitCommand || cmd.name !== 'init');

        filtered.sort((a, b) => {
          const aStartsWith = a.name.toLowerCase().startsWith(searchQuery.toLowerCase());
          const bStartsWith = b.name.toLowerCase().startsWith(searchQuery.toLowerCase());
          if (aStartsWith && !bStartsWith) return -1;
          if (!aStartsWith && bStartsWith) return 1;
          return a.name.localeCompare(b.name);
        });

        setCommands(filtered);
      } catch {

        const allowInitCommand = !hasMessagesInCurrentSession;
        const builtInCommands = buildBuiltInCommands({ hasSession, hasMessagesInCurrentSession });
        const categorized = builtInCommands.filter((cmd) => commandMatchesCategory(cmd, category));

        const filtered = (searchQuery
          ? categorized.filter(cmd =>
              fuzzyMatch(cmd.name, searchQuery) ||
              (cmd.description && fuzzyMatch(cmd.description, searchQuery))
            )
          : categorized).filter(cmd => allowInitCommand || cmd.name !== 'init');

        setCommands(filtered);
      } finally {
        setLoading(false);
      }
    };

    loadCommands();
  }, [searchQuery, hasMessagesInCurrentSession, hasSession, skills, extensionCommands, category]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [commands]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      block: 'nearest'
    });
  }, [selectedIndex]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      const total = commands.length;
      if (key === 'Escape') {
        onClose();
        return;
      }

      if (total === 0) {
        return;
      }

      if (key === 'ArrowDown') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((prev) => (prev + 1) % total);
        return;
      }

      if (key === 'ArrowUp') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((prev) => (prev - 1 + total) % total);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndexRef.current % total) + total) % total;
        const command = commands[safeIndex];
        if (command) {
          onCommandSelect(command);
        }
      }
    }
  }), [commands, onClose, onCommandSelect]);

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 z-[100] flex max-h-80 min-w-0 w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-lg"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <div
        role="group"
        aria-label="Filter commands"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5"
      >
        {COMMAND_CATEGORY_OPTIONS.map((option) => (
          <Button
            key={option.value}
            variant="chip"
            size="xs"
            aria-pressed={category === option.value}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setCategory(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <ScrollableOverlay
        role="listbox"
        aria-label="Commands"
        aria-activedescendant={!loading && commands[selectedIndex] ? `command-option-${selectedIndex}` : undefined}
        preventOverscroll
        outerClassName="flex-1 min-h-0"
        className="px-1 py-1.5"
      >
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Icon name="refresh" className="size-5 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : (
          <div>
            {commands.map((command, index) => {
              const isSelected = index === selectedIndex;
              const context = getCommandContext(command);
              return (
                <div
                  key={command.id}
                  id={`command-option-${index}`}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    'flex min-h-14 cursor-pointer items-start rounded-lg px-3 py-2.5',
                    isSelected
                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                      : 'text-foreground hover:bg-interactive-hover',
                  )}
                  // Keep the editor focused so selecting a command does not
                  // dismiss the soft keyboard on touch devices.
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerDown={(event) => {
                    if (event.pointerType !== 'touch') {
                      return;
                    }
                    pointerStartRef.current = { x: event.clientX, y: event.clientY };
                    pointerMovedRef.current = false;
                  }}
                  onPointerMove={(event) => {
                    if (event.pointerType !== 'touch' || !pointerStartRef.current) {
                      return;
                    }
                    const dx = event.clientX - pointerStartRef.current.x;
                    const dy = event.clientY - pointerStartRef.current.y;
                    if (Math.hypot(dx, dy) > 6) {
                      pointerMovedRef.current = true;
                    }
                  }}
                  onPointerUp={(event) => {
                    if (event.pointerType !== 'touch') {
                      return;
                    }
                    const didMove = pointerMovedRef.current;
                    pointerStartRef.current = null;
                    pointerMovedRef.current = false;
                    if (didMove) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    ignoreClickRef.current = true;
                    onCommandSelect(command);
                  }}
                  onPointerCancel={() => {
                    pointerStartRef.current = null;
                    pointerMovedRef.current = false;
                  }}
                  onClick={() => {
                    if (ignoreClickRef.current) {
                      ignoreClickRef.current = false;
                      return;
                    }
                    onCommandSelect(command);
                  }}
                  onMouseMove={() => {
                    keyboardNavigationRef.current = false;
                    setSelectedIndex(index);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate font-mono typography-ui-label font-medium">/{command.name}</span>
                      {context && (
                        <span className={cn(
                          'ml-auto max-w-[45%] shrink-0 truncate text-xs leading-4',
                          isSelected ? 'text-interactive-selection-foreground/75' : 'text-muted-foreground',
                        )}>
                          {context}
                        </span>
                      )}
                    </div>
                    {command.description && (
                      <div className={cn(
                        'mt-1 truncate text-xs leading-5',
                        isSelected ? 'text-interactive-selection-foreground/75' : 'text-muted-foreground',
                      )}>
                        {command.description}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {commands.length === 0 && (
              <div className="px-3 py-4 typography-ui-label text-muted-foreground">
                No commands found
              </div>
            )}
          </div>
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

CommandAutocomplete.displayName = 'CommandAutocomplete';
