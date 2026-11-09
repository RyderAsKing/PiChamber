import React from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useCatalogUiSessions } from '@/sync/sync-context';
import { resolveGlobalSessionDirectory } from '@/lib/chat/sessionDirectory';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import {
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitAllBranches, useGitStore } from '@/stores/useGitStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { toast } from '@/components/ui';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import type { Session } from '@/lib/chat/types';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { SETTINGS_PAGE_METADATA, type SettingsRuntimeContext } from '@/lib/settings/metadata';

const EMPTY_PINNED_SESSION_IDS = new Set<string>();
const PALETTE_KEY_HINTS: KeyHint[] = [
  { keys: ['↑', '↓'], label: 'Navigate' },
  { keys: ['↵'], label: 'Open' },
  { keys: ['Esc'], label: 'Close' },
];
import { getSettingsNavIcon } from '@/lib/settings/metadata';
import { Icon } from "@/components/icon/Icon";
import { ProjectIcon } from "@/components/ui/ProjectIcon";
import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { cn, truncatePathMiddle } from '@/lib/utils';
import { KeyHints, type KeyHint } from '@/components/ui/KeyHints';
import { MiddleTruncate } from '@/components/ui/MiddleTruncate';
import { sessionEvents } from '@/lib/sessionEvents';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildCommandPaletteFileSearchKey, scoreCommandPaletteFiles } from './commandPaletteFilesState';

type CommandEntry = {
  id: string;
  title: string;
  icon: React.ReactNode;
  shortcutId?: string;
  searchText: string;
  onSelect: () => void;
};

type FileHit = { path: string; name: string; relativePath: string };

const normalizePath = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) normalized = normalized.replace(/\/+$/, '');
  return normalized;
};

export const CommandPalette: React.FC = () => {

  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((s) => s.setSettingsPage);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const openContextOverview = useUIStore((s) => s.openContextOverview);
  const openContextSurface = useUIStore((s) => s.openContextSurface);
  const openContextFile = useUIStore((s) => s.openContextFile);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);

  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);

  const activeSessions = useCatalogUiSessions({ archived: false });
  const pinnedSessionIds = useSessionPinnedStore(React.useCallback(
    (state) => isCommandPaletteOpen ? state.ids : EMPTY_PINNED_SESSION_IDS,
    [isCommandPaletteOpen],
  ));
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => isCommandPaletteOpen ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [isCommandPaletteOpen],
  ));
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const activeProject = useProjectsStore((s) => s.getActiveProject());
  const projects = useProjectsStore((s) => s.projects);
  const effectiveDirectory = useEffectiveDirectory();
  const searchFiles = useFileSearchStore((s) => s.searchFiles);
  const { files: filesApi, git: gitApi } = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((s) => s.ensureStatus);
  const { isMobile } = useDeviceInfo();

  const currentRoot = React.useMemo(
    () => (effectiveDirectory ? normalizePath(effectiveDirectory) : null),
    [effectiveDirectory],
  );

  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const trimmedQuery = debouncedQuery.trim();
  const liveTrimmed = query.trim();

  // Clear query on open (not close) so content stays visible through the
  // close animation instead of emptying mid-flight.
  React.useEffect(() => {
    if (isCommandPaletteOpen) setQuery('');
  }, [isCommandPaletteOpen]);

  // Lazy-load git status for every session directory we plan to display so that
  // branch labels become available across all projects, not only the active one.
  // Deferred to idle to keep the first render (and the file-search effect) free
  // from a flood of git store updates.
  React.useEffect(() => {
    if (!isCommandPaletteOpen || !gitApi) return;
    const handle = setTimeout(() => {
      const seen = new Set<string>();
      for (const session of activeSessions) {
        const dir = resolveGlobalSessionDirectory(session);
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        void ensureGitStatus(dir, gitApi);
      }
    }, 0);
    return () => clearTimeout(handle);
  }, [isCommandPaletteOpen, activeSessions, gitApi, ensureGitStatus]);

  const close = React.useCallback(() => setCommandPaletteOpen(false), [setCommandPaletteOpen]);
  const run = React.useCallback(
    (fn: () => void | Promise<void>) => () => {
      close();
      void fn();
    },
    [close],
  );

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  const commands = React.useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = [
      {
        id: 'new-session',
        title: "New session",
        icon: <Icon name="add" className="mr-2 h-4 w-4" />,
        shortcutId: 'new_chat',
        searchText: "New session",
        onSelect: run(() => {
          setActiveMainTab('chat');
          setSessionSwitcherOpen(false);
          openNewSessionDraft();
        }),
      },
      {
        id: 'add-project',
        title: "Add folder",
        icon: <Icon name="folder-add" className="mr-2 h-4 w-4" />,
        searchText: "Add folder",
        onSelect: run(() => {
          sessionEvents.requestDirectoryDialog();
        }),
      },
      {
        id: 'toggle-sidebar',
        title: isMobile
          ? "Show session switcher"
          : "Toggle sidebar",
        icon: <Icon name="layout-left" className="mr-2 h-4 w-4" />,
        shortcutId: 'toggle_sidebar',
        searchText: isMobile
          ? "Show session switcher"
          : "Toggle sidebar",
        onSelect: run(() => {
          if (isMobile) {
            const { isSessionSwitcherOpen } = useUIStore.getState();
            setSessionSwitcherOpen(!isSessionSwitcherOpen);
          } else {
            toggleSidebar();
          }
        }),
      },
      {
        id: 'toggle-terminal',
        title: "Toggle terminal",
        icon: <Icon name="terminal-box" className="mr-2 h-4 w-4" />,
        shortcutId: 'toggle_terminal',
        searchText: "Toggle terminal",
        onSelect: run(() => {
          if (currentDirectory) openContextSurface(currentDirectory, 'terminal');
        }),
      },
      {
        id: 'context-usage',
        title: "Show context usage",
        icon: <Icon name="pie-chart" className="mr-2 h-4 w-4" />,
        searchText: "Show context usage",
        onSelect: run(() => {
          if (currentDirectory) openContextOverview(currentDirectory);
        }),
      },
      {
        id: 'open-settings',
        title: "Open settings…",
        icon: <Icon name="settings-3" className="mr-2 h-4 w-4" />,
        shortcutId: 'open_settings',
        searchText: "Open settings…",
        onSelect: run(() => setSettingsDialogOpen(true)),
      },
    ];
    if (canUseElectronDesktopIPC()) {
      list.splice(1, 0, {
        id: 'new-mini-chat',
        title: "New Mini Chat window",
        icon: <Icon name="window" className="mr-2 h-4 w-4" />,
        shortcutId: 'new_mini_chat',
        searchText: "New Mini Chat window",
        onSelect: run(() => {
          void invokeDesktop('desktop_open_draft_mini_chat_window', {
            directory: normalizePath(currentDirectory || activeProject?.path || ''),
            projectId: activeProject?.id ?? null,
          }).catch((error) => {
            console.warn('[command-palette] failed to open draft mini chat window', error);
          });
        }),
      });
    }
    return list;
  }, [
    run,
    isMobile,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    toggleSidebar,
    openContextSurface,
    currentDirectory,
    openContextOverview,
    setSettingsDialogOpen,
    activeProject?.id,
    activeProject?.path,
  ]);

  // ---------------------------------------------------------------------------
  // Settings sub-pages (only show when there's a query)
  // ---------------------------------------------------------------------------
  const settingsRuntimeCtx = React.useMemo<SettingsRuntimeContext>(() => {
    const isDesktop = isDesktopShell();
    return { isWeb: !isDesktop && isWebRuntime(), isDesktop, isMobile };
  }, [isMobile]);

  const settingsEntries = React.useMemo<CommandEntry[]>(() => {
    return SETTINGS_PAGE_METADATA
      .filter((p) => p.slug !== 'home')
      .filter((p) => (p.isAvailable ? p.isAvailable(settingsRuntimeCtx) : true))
      .map((page) => {
        const iconName = getSettingsNavIcon(page.slug) ?? 'settings-3';
        const keywords = (page.keywords ?? []).join(' ');
        return {
          id: `settings:${page.slug}`,
          title: page.title,
          icon: <Icon name={iconName} className="mr-2 h-4 w-4" />,
          searchText: `${page.title} ${page.group} ${keywords}`,
          onSelect: run(() => {
            setSettingsPage(page.slug);
            setSettingsDialogOpen(true);
          }),
        } satisfies CommandEntry;
      });
  }, [settingsRuntimeCtx, run, setSettingsPage, setSettingsDialogOpen]);

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------
  const orderedActiveSessions = React.useMemo(() => {
    return orderSessionsByLifecycleScopes(activeSessions, pinnedSessionIds, sessionOrderRanks);
  }, [activeSessions, pinnedSessionIds, sessionOrderRanks]);

  const allBranches = useGitAllBranches();

  // The project a session's folder belongs to: the longest project path that
  // is the folder or contains it. Tells apart sessions with the same title.
  const projectNameForDirectory = React.useCallback(
    (dir: string | null): string | null => {
      if (!dir) return null;
      let match: (typeof projects)[number] | null = null;
      for (const project of projects) {
        const root = project.path.replace(/\/+$/, '');
        if ((dir === root || dir.startsWith(`${root}/`)) && (!match || root.length > match.path.length)) {
          match = project;
        }
      }
      if (!match) return null;
      return match.label || match.path.split('/').pop() || match.path;
    },
    [projects],
  );

  const branchForSession = React.useCallback(
    (_sessionId: string, dir: string | null): string | null => {
      if (dir) return allBranches.get(dir)?.trim() || null;
      return null;
    },
    [allBranches],
  );

  // ---------------------------------------------------------------------------
  // File search
  // ---------------------------------------------------------------------------
  const [fileResults, setFileResults] = React.useState<FileHit[]>([]);
  const [fileResultsKey, setFileResultsKey] = React.useState('');

  const fileSearchKey = buildCommandPaletteFileSearchKey(currentRoot, trimmedQuery);

  React.useEffect(() => {
    if (!isCommandPaletteOpen) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    if (!fileSearchKey) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    if (!currentRoot) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    let cancelled = false;
    void searchFiles(currentRoot, trimmedQuery, 10, { type: 'file' })
      .then((results) => {
        if (cancelled) return;
        setFileResults(
          results.map((file) => ({
            path: normalizePath(file.path),
            name: file.name,
            relativePath: file.relativePath,
          })),
        );
        setFileResultsKey(fileSearchKey);
      })
      .catch(() => {
        if (!cancelled) {
          setFileResults([]);
          setFileResultsKey(fileSearchKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isCommandPaletteOpen, currentRoot, trimmedQuery, fileSearchKey, searchFiles]);

  // ---------------------------------------------------------------------------
  // Filter visible items
  // ---------------------------------------------------------------------------
  const hasQuery = liveTrimmed.length > 0;

  const scoredCommands = React.useMemo(() => {
    if (!hasQuery) return commands.map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(commands, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [commands, liveTrimmed, hasQuery]);

  const scoredSettings = React.useMemo(() => {
    if (!hasQuery) return [];
    return scoreByFuzzyQuery(settingsEntries, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [settingsEntries, liveTrimmed, hasQuery]);

  const scoredSessions = React.useMemo(() => {
    if (!hasQuery) return orderedActiveSessions.slice(0, 5).map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(orderedActiveSessions, liveTrimmed, (s) => s.title || '', {
      limit: 7,
      threshold: 0.2,
    });
  }, [orderedActiveSessions, liveTrimmed, hasQuery]);

  const scoredFiles = React.useMemo(() => {
    if (!isCommandPaletteOpen) return [];
    return scoreCommandPaletteFiles(fileResults, trimmedQuery, fileSearchKey, fileResultsKey);
  }, [isCommandPaletteOpen, fileResults, fileResultsKey, fileSearchKey, trimmedQuery]);

  const isFileSearchStale = isCommandPaletteOpen && fileSearchKey.length > 0 && fileResultsKey !== fileSearchKey;

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  const scoredProjects = React.useMemo(() => {
    if (!hasQuery) return [];
    const projectEntries = projects.map((project) => ({
      ...project,
      displayName: project.label || project.path.split('/').pop() || project.path,
      searchText: `${project.label || ''} ${project.path}`,
    }));
    return scoreByFuzzyQuery(projectEntries, liveTrimmed, (p) => p.searchText, {
      limit: 7,
      threshold: 0.4,
    });
  }, [projects, liveTrimmed, hasQuery]);

  const visibleCommands = scoredCommands.map((x) => x.item);
  const visibleSettings = scoredSettings.map((x) => x.item);
  const visibleSessions = scoredSessions.map((x) => x.item);
  const visibleFiles = hasQuery ? scoredFiles.map((x) => x.item) : [];
  const visibleProjects = hasQuery ? scoredProjects.map((x) => x.item) : [];

  const groupOrder = React.useMemo<('commands' | 'settings' | 'sessions' | 'files' | 'projects')[]>(() => {
    if (!hasQuery) return ['commands', 'sessions'];
    const best = (arr: { score: number }[]): number => (arr.length ? arr[0].score : Infinity);
    const groups: { key: 'commands' | 'settings' | 'sessions' | 'files' | 'projects'; score: number }[] = [
      { key: 'commands', score: best(scoredCommands) },
      { key: 'settings', score: best(scoredSettings) },
      { key: 'sessions', score: best(scoredSessions) },
      { key: 'files', score: best(scoredFiles) },
      { key: 'projects', score: best(scoredProjects) },
    ];
    groups.sort((a, b) => a.score - b.score);
    return groups.map((g) => g.key);
  }, [hasQuery, scoredCommands, scoredSettings, scoredSessions, scoredFiles, scoredProjects]);

  const handleOpenSession = React.useCallback(
    (session: Session) => {
      close();
      setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    },
    [close, setCurrentSession],
  );

  const handleOpenFile = React.useCallback(
    async (filePath: string) => {
      if (!currentRoot) return;
      const validation = await validateContextFileOpen(filesApi, filePath, { directory: currentRoot });
      if (!validation.ok) {
        toast.error(getContextFileOpenFailureMessage(validation.reason));
        return;
      }
      openContextFile(currentRoot, filePath);
      close();
    },
    [currentRoot, filesApi, openContextFile, close],
  );

  const handleOpenProject = React.useCallback(
    (projectId: string, projectPath: string) => {
      close();
      openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: projectPath });
    },
    [close, openNewSessionDraft],
  );

  const shortcut = React.useCallback(
    (actionId: string) =>
      formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides)),
    [shortcutOverrides],
  );

  return (
    <Dialog open={isCommandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>{"Command palette"}</DialogTitle>
        <DialogDescription>{"Search files, sessions, and commands."}</DialogDescription>
      </DialogHeader>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'w-full max-w-xl gap-0 self-start overflow-hidden rounded-2xl p-0',
          // Same frame as the Add folder palette: anchored near the top, so a
          // longer result list only moves the bottom edge.
          'mt-[max(env(safe-area-inset-top),0.25rem)] max-h-[calc(100%-0.5rem)] sm:mt-[10vh] sm:max-h-[80vh]',
        )}
      >
        <Command
          shouldFilter={false}
          className={cn(
            'rounded-none',
            '[&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:border-border/60 [&_[data-slot=command-input-wrapper]]:px-3.5',
            // The typography-* classes are plain CSS and take no variants, so
            // descendants get the matching font-size tokens directly.
            '[&_[cmdk-input]]:h-12 [&_[cmdk-input]]:text-[length:var(--text-markdown)] md:[&_[cmdk-input]]:text-[length:var(--text-ui-label)]',
            '[&_[cmdk-list]]:p-1.5 [&_[cmdk-group]]:p-0 [&_[cmdk-group]+[cmdk-group]]:mt-1',
            '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:text-[length:var(--text-micro)]',
            '[&_[cmdk-item]]:gap-2.5 [&_[cmdk-item]]:px-2.5 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]]:text-[length:var(--text-ui-label)]',
          )}
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={"Search files, sessions, commands..."}
          />
          <CommandList>
            <CommandEmpty>{"No results found."}</CommandEmpty>

            {groupOrder.map((groupKey) => {
              if (groupKey === 'commands' && visibleCommands.length > 0) {
                return (
                  <CommandGroup key="commands" heading={"Commands"}>
                    {visibleCommands.map((cmd) => (
                      <CommandItem key={cmd.id} value={cmd.id} onSelect={cmd.onSelect}>
                        {cmd.icon}
                        <span>{cmd.title}</span>
                        {cmd.shortcutId ? (
                          <CommandShortcut>{shortcut(cmd.shortcutId)}</CommandShortcut>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'settings' && visibleSettings.length > 0) {
                return (
                  <CommandGroup key="settings" heading={"Settings"}>
                    {visibleSettings.map((cmd) => (
                      <CommandItem key={cmd.id} value={cmd.id} onSelect={cmd.onSelect}>
                        {cmd.icon}
                        <span>{cmd.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'sessions' && visibleSessions.length > 0) {
                return (
                  <CommandGroup key="sessions" heading={"Sessions"}>
                    {visibleSessions.map((session) => {
                      const title = getSessionDisplayTitle(session);
                      const dir = resolveGlobalSessionDirectory(session);
                      const branch = branchForSession(session.id, dir);
                      const projectName = projectNameForDirectory(dir);
                      return (
                        <CommandItem
                          key={session.id}
                          value={`session:${session.id}`}
                          onSelect={() => handleOpenSession(session)}
                        >
                          <Icon name="chat-ai-3" className="mr-2 h-4 w-4" />
                          <span className="truncate">{title}</span>
                          {projectName || branch ? (
                            <span className="ml-auto inline-flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground typography-meta">
                              {projectName ? <span className="max-w-[140px] truncate">{projectName}</span> : null}
                              {branch ? (
                                <span className="inline-flex min-w-0 items-center gap-1">
                                  <Icon name="git-branch" className="h-3 w-3" />
                                  <MiddleTruncate value={branch} className="max-w-[160px]" />
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              if (groupKey === 'files' && visibleFiles.length > 0) {
                return (
                  <CommandGroup key="files" heading={"Files"}>
                    {visibleFiles.map((file) => {
                      const display = truncatePathMiddle(file.relativePath || file.name, {
                        maxLength: 80,
                      });
                      return (
                        <CommandItem
                          key={`file:${file.path}`}
                          value={`file:${file.path}`}
                          onSelect={() => {
                            void handleOpenFile(file.path);
                          }}
                        >
                          <FileTypeIcon filePath={file.path} className="mr-2 size-4 shrink-0" />
                          <span className="truncate" aria-label={file.relativePath}>
                            {display}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              if (groupKey === 'projects' && visibleProjects.length > 0) {
                return (
                  <CommandGroup key="projects" heading={"Projects"}>
                    {visibleProjects.map((project) => {
                      const displayName = project.displayName;
                      return (
                        <CommandItem
                          key={`project:${project.id}`}
                          value={`project:${project.id}`}
                          onSelect={() => handleOpenProject(project.id, project.path)}
                        >
                          <ProjectIcon directory={project.path} label={displayName} className="mr-2 size-4" />
                          <span className="truncate">{displayName}</span>
                          <span className="ml-auto inline-flex items-center text-muted-foreground typography-meta truncate max-w-[160px]">
                            {project.path}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              return null;
            })}

            {isFileSearchStale ? (
              <div className="px-3 py-2 typography-meta text-muted-foreground">
                {"Searching files..."}
              </div>
            ) : null}
          </CommandList>
        </Command>
        {!isMobile ? (
          <div className="flex min-h-10 shrink-0 items-center border-t border-border/60 bg-[var(--surface-muted)]/40 px-3 py-2 typography-micro text-muted-foreground">
            <KeyHints hints={PALETTE_KEY_HINTS} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
