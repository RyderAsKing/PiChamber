import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessages } from '@/sync/sync-context';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { commandMatchesSearch, mergeCommandAutocompleteItems } from './commandAutocompleteItems';
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
  isPiChamber?: boolean;
  isSkill?: boolean;
  scope?: string;
}

export interface CommandAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

const BASE_BADGE_CLASS = "text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0";
const TYPE_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  "bg-[color-mix(in_srgb,var(--primary-base)_12%,transparent)] text-[color-mix(in_srgb,var(--primary-base)_70%,transparent)] border-[color-mix(in_srgb,var(--primary-base)_24%,transparent)]"
);
const USER_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  "bg-[color-mix(in_srgb,var(--status-success)_12%,transparent)] text-[color-mix(in_srgb,var(--status-success)_70%,transparent)] border-[color-mix(in_srgb,var(--status-success)_24%,transparent)]"
);
const PROJECT_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  "bg-[color-mix(in_srgb,var(--status-info)_12%,transparent)] text-[color-mix(in_srgb,var(--status-info)_70%,transparent)] border-[color-mix(in_srgb,var(--status-info)_24%,transparent)]"
);
const NEUTRAL_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  "bg-[var(--surface-muted)] text-muted-foreground border-[var(--interactive-border)]/60"
);

interface CommandAutocompleteProps {
  searchQuery: string;
  onCommandSelect: (command: CommandInfo) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

const buildBuiltInCommands = (options: {
  hasSession: boolean;
  hasMessagesInCurrentSession: boolean;
  canStartSessionCommand: boolean;
}): CommandInfo[] => {
  const { hasSession, hasMessagesInCurrentSession, canStartSessionCommand } = options;
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
    ...(hasSession
      ? [{ id: 'pichamber:summary', name: 'summary', source: 'pichamber' as const, description: "Non-destructive session summary. Optional topic hint after the command.", isPiChamber: true }]
      : []
    ),
    ...(canStartSessionCommand
      ? [{ id: 'pichamber:plan-feature', name: 'plan-feature', source: 'pichamber' as const, description: "Start a guided, back-and-forth planning session for a new feature.", isPiChamber: true }]
      : []
    ),
    ...(canStartSessionCommand
      ? [{ id: 'pichamber:catch-up', name: 'catch-up', source: 'pichamber' as const, description: "Re-establish context: what you were doing and where to pick up.", isPiChamber: true }]
      : []
    ),
    ...(canStartSessionCommand
      ? [{ id: 'pichamber:debug', name: 'debug', source: 'pichamber' as const, description: "Guided root-cause investigation for a bug before proposing a fix.", isPiChamber: true }]
      : []
    ),
    ...(canStartSessionCommand
      ? [{ id: 'pichamber:weigh', name: 'weigh', source: 'pichamber' as const, description: "Weigh 2-3 approaches with trade-offs and a recommendation before you commit.", isPiChamber: true }]
      : []
    ),
    ...(canStartSessionCommand
      ? [{ id: 'pichamber:explore', name: 'explore', source: 'pichamber' as const, description: "Get oriented in this codebase: a high-level tour of the architecture and main parts.", isPiChamber: true }]
      : []
    ),
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
  const hasNewSessionDraft = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const canStartSessionCommand = hasSession || hasNewSessionDraft;
  const isMobile = useUIStore((state) => state.isMobile);

  const [commands, setCommands] = React.useState<CommandInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
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

        const builtInCommands = buildBuiltInCommands({ hasSession, hasMessagesInCurrentSession, canStartSessionCommand });
        const allCommands = mergeCommandAutocompleteItems(builtInCommands, [], skillCommands);
        const builtInNames = new Set(allCommands.map((cmd) => cmd.name));
        const withExtensions = [...allCommands, ...extensionCommands.filter((cmd) => !builtInNames.has(cmd.name))];

        const allowInitCommand = !hasMessagesInCurrentSession;
        const filtered = (searchQuery
          ? withExtensions.filter(cmd => commandMatchesSearch(cmd, searchQuery))
          : withExtensions).filter(cmd => allowInitCommand || cmd.name !== 'init');

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
        const builtInCommands = buildBuiltInCommands({ hasSession, hasMessagesInCurrentSession, canStartSessionCommand });

        const filtered = (searchQuery
          ? builtInCommands.filter(cmd =>
              fuzzyMatch(cmd.name, searchQuery) ||
              (cmd.description && fuzzyMatch(cmd.description, searchQuery))
            )
          : builtInCommands).filter(cmd => allowInitCommand || cmd.name !== 'init');

        setCommands(filtered);
      } finally {
        setLoading(false);
      }
    };

    loadCommands();
  }, [searchQuery, hasMessagesInCurrentSession, hasSession, canStartSessionCommand, skills, extensionCommands]);

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

  const getCommandIcon = (command: CommandInfo) => {

    switch (command.name) {
      case 'init':
        return <Icon name="file" className="h-3.5 w-3.5 text-green-500" />;
      case 'undo':
        return <Icon name="arrow-go-back" className="h-3.5 w-3.5 text-orange-500" />;
      case 'redo':
        return <Icon name="arrow-go-forward" className="h-3.5 w-3.5 text-orange-500" />;
      case 'timeline':
        return <Icon name="time" className="h-3.5 w-3.5" />;
      case 'compact':
        return <Icon name="scissors" className="h-3.5 w-3.5 text-purple-500" />;
      case 'review':
        return <Icon name="search-eye" className="h-3.5 w-3.5 text-blue-500" />;
      case 'test':
      case 'build':
      case 'run':
        return <Icon name="terminal-box" className="h-3.5 w-3.5 text-cyan-500" />;
      default:
        if (command.isBuiltIn) {
          return <Icon name="flashlight" className="h-3.5 w-3.5 text-yellow-500" />;
        }
        if (command.source === 'extension') {
          return <Icon name="plug-2" className="h-3.5 w-3.5 text-muted-foreground" />;
        }
        return <Icon name="command" className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[450px] max-h-64 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0 pb-2">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Icon name="refresh" className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div>
            {commands.map((command, index) => {
              const isSystem = command.isBuiltIn;
              const isPiChamberBadge = command.isPiChamber;
              return (
                <div
                  key={command.id}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  className={cn(
                    "flex gap-2 px-3 py-2 cursor-pointer rounded-lg",
                    isMobile ? "items-center" : "items-start",
                    index === selectedIndex && "bg-interactive-selection"
                  )}
                  // Block the focus transfer the tap would perform: the textarea
                  // must stay focused so selecting a command doesn't dismiss the
                  // soft keyboard (the blur raced the keyboard-hide trigger and
                  // won against the deferred refocus).
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
                  <div className={cn(!isMobile && "mt-0.5")}>
                    {getCommandIcon(command)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="typography-ui-label font-medium">/{command.name}</span>
                      {command.isSkill ? (
                        <span className={TYPE_BADGE_CLASS}>
                          {"skill"}
                        </span>
                      ) : (
                        <span className={TYPE_BADGE_CLASS}>
                          {"command"}
                        </span>
                      )}
                      {isPiChamberBadge ? (
                        <span className={NEUTRAL_BADGE_CLASS}>
                          PiChamber
                        </span>
                      ) : isSystem ? (
                        <span className={NEUTRAL_BADGE_CLASS}>
                          {"system"}
                        </span>
                      ) : command.scope ? (
                        <span className={command.scope === 'project' ? PROJECT_BADGE_CLASS : USER_BADGE_CLASS}>
                          {command.scope}
                        </span>
                      ) : null}
                      {command.agent && (
                        <span className={NEUTRAL_BADGE_CLASS}>
                          {command.agent}
                        </span>
                      )}
                    </div>
                    {command.description && !isMobile && (
                      <div className="typography-meta text-muted-foreground mt-0.5 truncate">
                        {command.description}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {commands.length === 0 && (
              <div className="px-3 py-2 typography-ui-label text-muted-foreground">
                {"No commands found"}
              </div>
            )}
          </div>
        )}
      </ScrollableOverlay>
      {!isMobile && (
        <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
          {"↑↓ navigate • Enter select • Esc close"}
        </div>
      )}
    </div>
  );
});

CommandAutocomplete.displayName = 'CommandAutocomplete';
