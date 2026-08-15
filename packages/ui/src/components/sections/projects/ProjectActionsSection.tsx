import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { isDesktopShell } from '@/lib/desktop';
import {
  getProjectActionsState,
  saveProjectActionsState,
  type PiChamberProjectAction,
  type ProjectRef,
} from '@/lib/pichamberConfig';
import {
  buildProjectActionDesktopForwardOptions,
  PROJECT_ACTION_ICON_MAP,
  PROJECT_ACTION_ICONS,
  PROJECT_ACTIONS_UPDATED_EVENT,
} from '@/lib/projectActions';
import {
  PROJECT_SETTINGS_CONTROL_WIDTH,
  ProjectSettingsSubsection,
} from '@/components/sections/projects/ProjectSettingsSubsection';
import { SETTINGS_SELECT_SIZE } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { cn } from '@/lib/utils';

type EditableProjectAction = PiChamberProjectAction;

const AUTO_SAVE_DELAY_MS = 450;

const createActionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
};

const createEmptyAction = (): EditableProjectAction => ({
  id: createActionId(),
  name: '',
  command: '',
  icon: 'play',
});

interface ProjectActionsSectionProps {
  projectRef: ProjectRef;
}

export const ProjectActionsSection: React.FC<ProjectActionsSectionProps> = ({ projectRef }) => {
  const isDesktopShellApp = React.useMemo(() => isDesktopShell(), []);
  const desktopSshInstances = useDesktopSshStore((state) => state.instances);
  const loadDesktopSsh = useDesktopSshStore((state) => state.load);

  const [actions, setActions] = React.useState<EditableProjectAction[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [initialSnapshot, setInitialSnapshot] = React.useState<string | null>(null);
  const [expandedActions, setExpandedActions] = React.useState<Record<string, boolean>>({});
  const isSavingRef = React.useRef(false);
  const validationToastShownRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!isDesktopShellApp) {
      return;
    }
    void loadDesktopSsh().catch(() => undefined);
  }, [isDesktopShellApp, loadDesktopSsh]);

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const state = await getProjectActionsState(projectRef);
        if (cancelled) {
          return;
        }
        setActions(state.actions);
        setInitialSnapshot(JSON.stringify({ actions: state.actions }));
      } catch {
        if (cancelled) {
          return;
        }
        setActions([]);
        setInitialSnapshot(JSON.stringify({ actions: [] }));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRef]);

  const desktopForwardOptions = React.useMemo(() => {
    if (!isDesktopShellApp) {
      return [];
    }
    return buildProjectActionDesktopForwardOptions(desktopSshInstances);
  }, [desktopSshInstances, isDesktopShellApp]);

  const validationError = React.useMemo(() => {
    const hasIncomplete = actions.some((entry) => {
      return entry.name.trim().length === 0 || entry.command.trim().length === 0;
    });
    if (hasIncomplete) {
      return "Fill action name and command before saving.";
    }
    return null;
  }, [actions]);

  const hasChanges = React.useMemo(() => {
    if (initialSnapshot === null) {
      return false;
    }
    return initialSnapshot !== JSON.stringify({ actions });
  }, [actions, initialSnapshot]);

  const persistActions = React.useCallback(async (nextActions: EditableProjectAction[]) => {
    const ok = await saveProjectActionsState(projectRef, {
      actions: nextActions,
      primaryActionId: null,
    });
    if (!ok) {
      toast.error("Failed to save actions");
      return false;
    }
    setInitialSnapshot(JSON.stringify({ actions: nextActions }));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PROJECT_ACTIONS_UPDATED_EVENT, {
        detail: { projectId: projectRef.id },
      }));
    }
    return true;
  }, [projectRef]);

  React.useEffect(() => {
    if (!hasChanges || isLoading || validationError || isSavingRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (isSavingRef.current) {
        return;
      }
      isSavingRef.current = true;
      void (async () => {
        try {
          await persistActions(actions);
        } finally {
          isSavingRef.current = false;
        }
      })();
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [actions, hasChanges, isLoading, persistActions, validationError]);

  React.useEffect(() => {
    if (!hasChanges || !validationError || isLoading) {
      if (!validationError) {
        validationToastShownRef.current = null;
      }
      return;
    }

    const timer = window.setTimeout(() => {
      if (validationToastShownRef.current === validationError) {
        return;
      }
      validationToastShownRef.current = validationError;
      toast.error(validationError);
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [hasChanges, isLoading, validationError]);

  const handleAddAction = React.useCallback(() => {
    const nextAction = createEmptyAction();
    setActions((prev) => [...prev, nextAction]);
    setExpandedActions((prev) => ({
      ...prev,
      [nextAction.id]: true,
    }));
  }, []);

  const handleRemoveAction = React.useCallback((id: string) => {
    setActions((prev) => prev.filter((entry) => entry.id !== id));
    setExpandedActions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const updateAction = React.useCallback((id: string, updater: (current: EditableProjectAction) => EditableProjectAction) => {
    setActions((prev) => prev.map((entry) => (entry.id === id ? updater(entry) : entry)));
  }, []);

  return (
    <ProjectSettingsSubsection
      title={"Actions"}
      info={"Per-project commands shown in header next to project name."}
      settingsItem="projects.actions"
      headerAction={(
        <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={handleAddAction}>
          <Icon name="add" className="h-3.5 w-3.5" />
          {"Add action"}
        </Button>
      )}
      contentClassName="space-y-0"
    >
      {isLoading ? (
        <p className="typography-meta text-muted-foreground">{"Loading..."}</p>
      ) : actions.length === 0 ? (
        <p className="typography-meta text-muted-foreground">{"No actions configured yet."}</p>
      ) : (
        <div className={cn('space-y-0', PROJECT_SETTINGS_CONTROL_WIDTH)}>
          {actions.map((action) => {
            const selectedIconKey = (action.icon as keyof typeof PROJECT_ACTION_ICON_MAP) || 'play';
            const selectedIconName = PROJECT_ACTION_ICON_MAP[selectedIconKey] || 'play';
            const isOpen = expandedActions[action.id] ?? false;
            const title = action.name.trim() || "Untitled action";

            return (
              <Collapsible
                key={action.id}
                open={isOpen}
                onOpenChange={(open) => {
                  setExpandedActions((prev) => ({
                    ...prev,
                    [action.id]: open,
                  }));
                }}
                className="py-1.5"
              >
                <div className="flex items-start gap-2">
                  <CollapsibleTrigger className="group flex-1 justify-start gap-2 rounded-md px-0 pr-1 py-1 hover:bg-[var(--interactive-hover)] focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]">
                    {isOpen ? (
                      <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground" />
                    )}
                    <Icon name={selectedIconName} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <span className="typography-ui-label text-foreground truncate">{title}</span>
                    </div>
                  </CollapsibleTrigger>

                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="!font-normal h-7 w-7 px-0 text-muted-foreground hover:text-[var(--status-error)]"
                    onClick={() => handleRemoveAction(action.id)}
                  >
                    <Icon name="delete-bin" className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <CollapsibleContent className="pt-1.5">
                  <div className="space-y-2 pb-4 pl-3 pr-1">
                    <div className="flex items-center gap-2 py-1">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--interactive-border)] text-foreground hover:bg-[var(--interactive-hover)]"
                            aria-label={"Select icon"}
                          >
                            <Icon name={selectedIconName} className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56 p-2">
                          <div className="grid grid-cols-6 gap-1">
                            {PROJECT_ACTION_ICONS.map((entry) => {
                              const iconName = entry.Icon;
                              const selected = (action.icon || 'play') === entry.key;
                              return (
                                <button
                                  key={entry.key}
                                  type="button"
                                  onClick={() => updateAction(action.id, (current) => ({ ...current, icon: entry.key }))}
                                  className={cn(
                                    'inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-foreground hover:bg-[var(--interactive-hover)]',
                                    selected && 'border-[var(--primary-base)] bg-[var(--primary-base)]/10 text-[var(--primary-base)]'
                                  )}
                                  aria-label={`Icon ${entry.label}`}
                                >
                                  <Icon name={iconName} className="h-4 w-4" />
                                </button>
                              );
                            })}
                          </div>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <Input
                        value={action.name}
                        onChange={(event) => updateAction(action.id, (current) => ({ ...current, name: event.target.value }))}
                        placeholder={"Action name"}
                        className="h-7 flex-1 min-w-0"
                      />
                    </div>

                    <div className="py-1">
                      <p className="typography-meta mb-0.5 text-muted-foreground">{"Command"}</p>
                      <Textarea
                        value={action.command}
                        onChange={(event) => updateAction(action.id, (current) => ({ ...current, command: event.target.value }))}
                        placeholder={"e.g. bun run lint"}
                        className="min-h-[88px] w-full font-mono text-xs"
                      />
                    </div>

                    <div className="py-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="typography-ui-label text-foreground">{"Auto-open URL"}</span>
                        <div
                          className="group flex cursor-pointer items-center gap-2"
                          role="button"
                          tabIndex={0}
                          aria-pressed={action.autoOpenUrl === true}
                          onClick={() => updateAction(action.id, (current) => ({
                            ...current,
                            ...(current.autoOpenUrl === true ? { autoOpenUrl: undefined } : { autoOpenUrl: true }),
                          }))}
                          onKeyDown={(event) => {
                            if (event.key === ' ' || event.key === 'Enter') {
                              event.preventDefault();
                              updateAction(action.id, (current) => ({
                                ...current,
                                ...(current.autoOpenUrl === true ? { autoOpenUrl: undefined } : { autoOpenUrl: true }),
                              }));
                            }
                          }}
                        >
                          <Checkbox
                            checked={action.autoOpenUrl === true}
                            onChange={(checked) => updateAction(action.id, (current) => ({
                              ...current,
                              ...(checked ? { autoOpenUrl: true } : { autoOpenUrl: undefined }),
                            }))}
                            ariaLabel={`Auto-open URL for ${title}`}
                          />
                          <span className="typography-ui-label font-normal text-foreground/80">{"Open URL from output or custom URL below"}</span>
                        </div>
                      </div>

                      {action.autoOpenUrl === true ? (
                        <div className="mt-1">
                          <div className="flex items-center gap-2">
                            <Input
                              value={action.openUrl || ''}
                              onChange={(event) => updateAction(action.id, (current) => ({
                                ...current,
                                openUrl: event.target.value,
                              }))}
                              placeholder={"Override URL (optional)"}
                              className="h-7 w-full max-w-[24rem]"
                            />
                            <SettingsInfoHint contentClassName="max-w-xs">
                              {"If this field is filled, custom URL is used. If empty, app opens best URL from output."}
                            </SettingsInfoHint>
                          </div>

                          {isDesktopShellApp ? (
                            <div className="mt-2">
                              <p className="typography-meta mb-0.5 text-muted-foreground">{"Desktop SSH forward"}</p>
                              {desktopForwardOptions.length > 0 ? (
                                <Select
                                  value={
                                    action.desktopOpenSshForward && desktopForwardOptions.some((entry) => entry.id === action.desktopOpenSshForward)
                                      ? action.desktopOpenSshForward
                                      : '__none__'
                                  }
                                  onValueChange={(value) => {
                                    updateAction(action.id, (current) => ({
                                      ...current,
                                      ...(value === '__none__' ? { desktopOpenSshForward: undefined } : { desktopOpenSshForward: value }),
                                    }));
                                  }}
                                >
                                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full">
                                    <SelectValue placeholder={"Use output/manual URL"} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">{"Use output/manual URL"}</SelectItem>
                                    {desktopForwardOptions.map((entry) => (
                                      <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : (
                                <p className="typography-meta text-muted-foreground">{"No enabled local SSH forwards available."}</p>
                              )}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}

      {validationError && actions.length > 0 ? (
        <p className="typography-meta text-[var(--status-warning)]">{validationError}</p>
      ) : null}
    </ProjectSettingsSubsection>
  );
};
