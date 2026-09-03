import React from "react";
import { cn } from "@/lib/utils";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useSessionMessages } from "@/sync/sync-context";
import { ScrollableOverlay } from "@/components/ui/ScrollableOverlay";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from "@/stores/useUIStore";
import { useMobileAutocompleteMaxHeight } from "./useMobileAutocompleteMaxHeight";
import {
  commandInvocationName,
  commandMatchesCategory,
  commandMatchesSearch,
  mergeCommandAutocompleteItems,
  type CommandAutocompleteCategory,
} from "./commandAutocompleteItems";
import { useEffectiveDirectory } from "@/hooks/useEffectiveDirectory";
import { useCommandCatalog } from "@/hooks/useCommandCatalog";

/**
 * Slash-command catalog entry.
 *
 * `name` is display metadata (for skills the bare resource name), while
 * `invocationName` is the executable identity Pi resolves (`review`,
 * `skill:code-review`, or a registered extension invocation including any
 * Pi-generated suffix). Callers must insert `invocationName`, never
 * reconstruct skill syntax from flags.
 */
export type CommandSource = "pichamber" | "system" | "pi" | "skill" | "extension" | "prompt";

export interface CommandInfo {
  id: string;
  name: string;
  invocationName: string;
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
  if (command.source === "skill" || command.isSkill) return "Skill";
  if (command.source === "extension") return "Extension";
  if (command.source === "prompt") return "Prompt";
  if (command.source === "system" || command.source === "pichamber" || command.isBuiltIn) return "System";
  const labels = [command.scope, command.agent].filter(
    (label): label is string => Boolean(label),
  );
  return labels.length > 0 ? labels.join(" · ") : null;
};

const COMMAND_CATEGORY_OPTIONS: ReadonlyArray<{
  value: CommandAutocompleteCategory;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "system", label: "System" },
  { value: "prompts", label: "Prompts" },
  { value: "skills", label: "Skills" },
  { value: "extensions", label: "Extensions" },
];

interface CommandAutocompleteProps {
  searchQuery: string;
  onCommandSelect: (command: CommandInfo) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

export const CommandAutocomplete = React.forwardRef<
  CommandAutocompleteHandle,
  CommandAutocompleteProps
>(({ searchQuery, onCommandSelect, onClose, style }, ref) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionMessages = useSessionMessages(currentSessionId ?? "");
  const hasMessagesInCurrentSession = sessionMessages.length > 0;
  const hasSession = Boolean(currentSessionId);
  const isMobile = useUIStore((state) => state.isMobile);

  const [category, setCategory] =
    React.useState<CommandAutocompleteCategory>("all");
  const effectiveDirectory = useEffectiveDirectory();
  const { commands: catalogCommands, isLoading: catalogLoading } =
    useCommandCatalog(effectiveDirectory);

  const [commands, setCommands] = React.useState<CommandInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const keyboardNavigationRef = React.useRef(false);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(
    containerRef,
    isMobile,
  );
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

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [onClose]);

  React.useEffect(() => {
    setLoading(catalogLoading);
    // System commands intercept before Pi; only show session-bound ones when
    // a session exists. `compact` is always available (it creates no session
    // by itself; the send path requires one). `init` is intentionally absent:
    // it has no browser-path handler and must not be advertised.
    const systemCommands: CommandInfo[] = catalogCommands
      .filter((c) => c.source === "system")
      .filter((c) => {
        if (c.invocationName === "compact") return true;
        return hasSession;
      })
      .map((c) => ({
        id: c.id,
        name: c.name,
        invocationName: c.invocationName,
        source: "system" as const,
        description: c.description,
        isBuiltIn: true,
        ...(c.scope ? { scope: c.scope } : {}),
      }));

    const nativeCommands: CommandInfo[] = catalogCommands
      .filter((c) => c.source !== "system")
      .map((c) => ({
        id: c.id,
        name: c.name,
        invocationName: c.invocationName,
        source: c.source,
        description: c.description,
        ...(c.source === "skill" ? { isSkill: true as const } : {}),
        ...(c.scope ? { scope: c.scope } : {}),
      }));

    const allCommands = mergeCommandAutocompleteItems(
      systemCommands,
      nativeCommands.filter((c) => c.source === "extension"),
      nativeCommands.filter((c) => c.source === "skill"),
      nativeCommands.filter((c) => c.source === "prompt"),
    );

    const categorized = allCommands.filter((cmd) =>
      commandMatchesCategory(cmd, category),
    );
    const normalizedQuery = searchQuery.trim();
    const filtered = normalizedQuery
      ? categorized.filter((cmd) => commandMatchesSearch(cmd, normalizedQuery))
      : categorized;

    filtered.sort((a, b) => {
      const aInvocation = commandInvocationName(a).toLowerCase();
      const bInvocation = commandInvocationName(b).toLowerCase();
      const query = normalizedQuery.toLowerCase();
      const aStartsWith = query.length > 0 && aInvocation.startsWith(query);
      const bStartsWith = query.length > 0 && bInvocation.startsWith(query);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return aInvocation.localeCompare(bInvocation);
    });

    setCommands(filtered);
  }, [
    searchQuery,
    hasSession,
    hasMessagesInCurrentSession,
    catalogCommands,
    catalogLoading,
    category,
  ]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [commands]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedIndex]);

  React.useImperativeHandle(
    ref,
    () => ({
      handleKeyDown: (key: string) => {
        const total = commands.length;
        if (key === "Escape") {
          onClose();
          return;
        }

        if (total === 0) {
          return;
        }

        if (key === "ArrowDown") {
          keyboardNavigationRef.current = true;
          setSelectedIndex((prev) => (prev + 1) % total);
          return;
        }

        if (key === "ArrowUp") {
          keyboardNavigationRef.current = true;
          setSelectedIndex((prev) => (prev - 1 + total) % total);
          return;
        }

        if (key === "Enter" || key === "Tab") {
          const safeIndex =
            ((selectedIndexRef.current % total) + total) % total;
          const command = commands[safeIndex];
          if (command) {
            onCommandSelect(command);
          }
        }
      },
    }),
    [commands, onClose, onCommandSelect],
  );

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 z-[100] flex max-h-80 min-w-0 w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-lg"
      style={
        mobileMaxHeight !== undefined
          ? { ...style, maxHeight: mobileMaxHeight }
          : style
      }
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
        aria-activedescendant={
          !loading && commands[selectedIndex]
            ? `command-option-${selectedIndex}`
            : undefined
        }
        preventOverscroll
        outerClassName="flex-1 min-h-0"
        className="px-1 py-1.5"
      >
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Icon
              name="refresh"
              className="size-5 animate-spin text-muted-foreground"
              aria-hidden
            />
          </div>
        ) : (
          <div>
            {commands.map((command, index) => {
              const isSelected = index === selectedIndex;
              const context = getCommandContext(command);
              const invocation = commandInvocationName(command);
              return (
                <div
                  key={command.id}
                  id={`command-option-${index}`}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    "flex min-h-14 cursor-pointer items-start rounded-lg px-3 py-2.5",
                    isSelected
                      ? "bg-interactive-selection text-interactive-selection-foreground"
                      : "text-foreground hover:bg-interactive-hover",
                  )}
                  // Keep the editor focused so selecting a command does not
                  // dismiss the soft keyboard on touch devices.
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerDown={(event) => {
                    if (event.pointerType !== "touch") {
                      return;
                    }
                    pointerStartRef.current = {
                      x: event.clientX,
                      y: event.clientY,
                    };
                    pointerMovedRef.current = false;
                  }}
                  onPointerMove={(event) => {
                    if (
                      event.pointerType !== "touch" ||
                      !pointerStartRef.current
                    ) {
                      return;
                    }
                    const dx = event.clientX - pointerStartRef.current.x;
                    const dy = event.clientY - pointerStartRef.current.y;
                    if (Math.hypot(dx, dy) > 6) {
                      pointerMovedRef.current = true;
                    }
                  }}
                  onPointerUp={(event) => {
                    if (event.pointerType !== "touch") {
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
                      <span className="min-w-0 truncate font-mono typography-ui-label font-medium">
                        /{invocation}
                      </span>
                      {context && (
                        <span
                          className={cn(
                            "ml-auto max-w-[45%] shrink-0 truncate text-xs leading-4",
                            isSelected
                              ? "text-interactive-selection-foreground/75"
                              : "text-muted-foreground",
                          )}
                        >
                          {context}
                        </span>
                      )}
                    </div>
                    {command.description && (
                      <div
                        className={cn(
                          "mt-1 truncate text-xs leading-5",
                          isSelected
                            ? "text-interactive-selection-foreground/75"
                            : "text-muted-foreground",
                        )}
                      >
                        {command.description}
                      </div>
                    )}
                    {command.source === "skill" && command.name !== invocation && (
                      <div
                        className={cn(
                          "mt-0.5 truncate text-xs leading-4",
                          isSelected
                            ? "text-interactive-selection-foreground/60"
                            : "text-muted-foreground/80",
                        )}
                      >
                        {command.name}
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

CommandAutocomplete.displayName = "CommandAutocomplete";
