import React from 'react';
import { Button } from '@/components/ui/button';
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
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_GROUP_TITLE_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsCheckboxRow,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import {
  getPersistableProjectActions,
  isProjectActionPartial,
} from '@/components/sections/projects/projectActionDraft';

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
  const [savedActionIds, setSavedActionIds] = React.useState<Set<string>>(new Set());
  const isSavingRef = React.useRef(false);

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
        setSavedActionIds(new Set(state.actions.map((entry) => entry.id)));
      } catch {
        if (cancelled) {
          return;
        }
        setActions([]);
        setInitialSnapshot(JSON.stringify({ actions: [] }));
        setSavedActionIds(new Set());
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

  const persistPlan = React.useMemo(
    () => getPersistableProjectActions(actions, savedActionIds),
    [actions, savedActionIds],
  );

  const persistSnapshot = React.useMemo(
    () => JSON.stringify({ actions: persistPlan.actions }),
    [persistPlan.actions],
  );

  const hasPersistableChanges = initialSnapshot !== null
    && persistPlan.canPersist
    && persistSnapshot !== initialSnapshot;

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
    setSavedActionIds(new Set(nextActions.map((entry) => entry.id)));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PROJECT_ACTIONS_UPDATED_EVENT, {
        detail: { projectId: projectRef.id },
      }));
    }
    return true;
  }, [projectRef]);

  React.useEffect(() => {
    if (!hasPersistableChanges || isLoading || isSavingRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (isSavingRef.current) {
        return;
      }
      isSavingRef.current = true;
      void (async () => {
        try {
          await persistActions(persistPlan.actions);
        } finally {
          isSavingRef.current = false;
        }
      })();
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [hasPersistableChanges, isLoading, persistActions, persistPlan.actions]);

  const handleAddAction = React.useCallback(() => {
    const nextAction = createEmptyAction();
    setActions((prev) => [...prev, nextAction]);
  }, []);

  const handleRemoveAction = React.useCallback((id: string) => {
    setActions((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const updateAction = React.useCallback((id: string, updater: (current: EditableProjectAction) => EditableProjectAction) => {
    setActions((prev) => prev.map((entry) => (entry.id === id ? updater(entry) : entry)));
  }, []);

  return (
    <ProjectSettingsSubsection
      title={"Actions"}
      info={"Per-project commands shown in the header next to the project name."}
      settingsItem="projects.actions"
      headerAction={(
        <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={handleAddAction}>
          <Icon name="add" className="h-3.5 w-3.5" />
          {"Add action"}
        </Button>
      )}
      contentClassName="space-y-4"
    >
      {isLoading ? (
        <p className="typography-meta text-muted-foreground">{"Loading..."}</p>
      ) : actions.length === 0 ? (
        <p className="typography-meta text-muted-foreground">{"No actions configured yet."}</p>
      ) : (
        <div className={cn('space-y-6', PROJECT_SETTINGS_CONTROL_WIDTH)}>
          {actions.map((action, index) => {
            const selectedIconKey = (action.icon as keyof typeof PROJECT_ACTION_ICON_MAP) || 'play';
            const selectedIconName = PROJECT_ACTION_ICON_MAP[selectedIconKey] || 'play';
            const title = action.name.trim() || `Action ${index + 1}`;
            const isPartial = isProjectActionPartial(action);

            return (
              <div key={action.id} className={SETTINGS_FIELDS_STACK_CLASS}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className={SETTINGS_GROUP_TITLE_CLASS}>{title}</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-8 w-8 px-0 text-muted-foreground hover:text-[var(--status-error)]"
                    onClick={() => handleRemoveAction(action.id)}
                    aria-label={`Delete ${title}`}
                  >
                    <Icon name="delete-bin" className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <SettingsStackedField
                  label={"Name"}
                  controlClassName="w-full max-w-none"
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--interactive-border)] text-foreground hover:bg-[var(--interactive-hover)]"
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
                    className="h-8 min-w-0 flex-1 rounded-md px-3"
                  />
                </SettingsStackedField>

                <SettingsStackedField
                  label={"Command"}
                  controlClassName="w-full max-w-none"
                >
                  <Textarea
                    value={action.command}
                    onChange={(event) => updateAction(action.id, (current) => ({ ...current, command: event.target.value }))}
                    placeholder={"e.g. bun run lint"}
                    className="min-h-[88px] w-full font-mono text-xs"
                  />
                </SettingsStackedField>

                {isPartial ? (
                  <p className="typography-meta text-muted-foreground">
                    {"Enter a name and command to save this action."}
                  </p>
                ) : null}

                <SettingsCheckboxRow
                  checked={action.autoOpenUrl === true}
                  onChange={(checked) => updateAction(action.id, (current) => ({
                    ...current,
                    ...(checked ? { autoOpenUrl: true } : { autoOpenUrl: undefined, openUrl: undefined, desktopOpenSshForward: undefined }),
                  }))}
                  label={"Auto-open URL"}
                  info={"Opens a URL from command output, or a custom URL if you set one."}
                  ariaLabel={`Auto-open URL for ${title}`}
                />

                {action.autoOpenUrl === true ? (
                  <>
                    <SettingsStackedField
                      label={"Custom URL"}
                      info={"Leave empty to use the best URL from command output."}
                      controlClassName="w-full max-w-none"
                    >
                      <Input
                        value={action.openUrl || ''}
                        onChange={(event) => updateAction(action.id, (current) => ({
                          ...current,
                          openUrl: event.target.value,
                        }))}
                        placeholder={"https://localhost:3000"}
                        className="h-8 w-full rounded-md px-3"
                      />
                    </SettingsStackedField>

                    {isDesktopShellApp ? (
                      <SettingsStackedField
                        label={"Desktop SSH forward"}
                        controlClassName="w-full max-w-none"
                      >
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
                      </SettingsStackedField>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </ProjectSettingsSubsection>
  );
};
