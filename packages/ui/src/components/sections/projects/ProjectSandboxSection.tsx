import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ProjectSettingsSubsection } from '@/components/sections/projects/ProjectSettingsSubsection';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsChipGroup,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { reportSettingsSaveState } from '@/lib/persistence';
import { sandboxReasonText } from '@/lib/pi/sandboxText';
import type {
  PiProjectSandboxSetting,
  PiProjectSandboxState,
  PiSandboxExtraFolder,
  PiSandboxMode,
} from '@/lib/pi/protocol';
import { useProjectSandboxStore } from '@/stores/useProjectSandboxStore';
import {
  buildSetting,
  draftFromState,
  settingDiffers,
  type ProjectSandboxDraft,
} from './projectSandboxDraft';

const FOLDER_ACCESS_LABELS: Record<PiSandboxExtraFolder['access'], string> = {
  read: 'Read only',
  readWrite: 'Read and write',
};

const MODE_OPTIONS: Array<{ value: PiSandboxMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'nono', label: 'nono' },
];

interface ProjectSandboxSectionProps {
  projectId: string;
}

/** Per-project sandbox setting (#242): mode, allowed hosts, local ports and
 *  extra folders. Host-local: it lives on the server and is never synced. */
export const ProjectSandboxSection: React.FC<ProjectSandboxSectionProps> = ({ projectId }) => {
  const state = useProjectSandboxStore((store) => store.projects[projectId]);
  const projectsStatus = useProjectSandboxStore((store) => store.projectsStatus);
  const saving = useProjectSandboxStore((store) => Boolean(store.saving[projectId]));
  const saveError = useProjectSandboxStore((store) => store.saveErrors[projectId]);
  const loadProjects = useProjectSandboxStore((store) => store.loadProjects);
  const saveProject = useProjectSandboxStore((store) => store.saveProject);

  React.useEffect(() => {
    if (projectsStatus === 'idle') void loadProjects();
  }, [loadProjects, projectsStatus]);

  const onSave = React.useCallback(async (setting: PiProjectSandboxSetting) => {
    if (!settingDiffers(setting, useProjectSandboxStore.getState().projects[projectId])) return;
    reportSettingsSaveState('saving');
    const saved = await saveProject(projectId, setting);
    reportSettingsSaveState(saved ? 'saved' : 'error');
  }, [projectId, saveProject]);

  return (
    <ProjectSandboxSectionView
      projectId={projectId}
      state={state}
      loadFailed={projectsStatus === 'failed'}
      saving={saving}
      saveError={saveError}
      onReload={() => void loadProjects()}
      onSave={onSave}
    />
  );
};

interface ProjectSandboxSectionViewProps {
  projectId: string;
  state: PiProjectSandboxState | undefined;
  loadFailed: boolean;
  saving: boolean;
  saveError: string | undefined;
  onReload: () => void;
  onSave: (setting: PiProjectSandboxSetting) => Promise<void>;
}

export const ProjectSandboxSectionView: React.FC<ProjectSandboxSectionViewProps> = ({
  projectId,
  state,
  loadFailed,
  saving,
  saveError,
  onReload,
  onSave,
}) => {
  const [draft, setDraft] = React.useState<ProjectSandboxDraft>(() => draftFromState(state));
  const [localError, setLocalError] = React.useState<string | null>(null);

  // Take the server's answer whenever it changes (load, save, another device).
  const stateKey = state ? JSON.stringify(state) : '';
  React.useEffect(() => {
    setDraft(draftFromState(state));
    setLocalError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stateKey]);

  const save = React.useCallback(async (next: ProjectSandboxDraft) => {
    const built = buildSetting(next);
    if (!built.ok) {
      setLocalError(built.error);
      return;
    }
    setLocalError(null);
    await onSave(built.setting);
  }, [onSave]);

  const update = (patch: Partial<ProjectSandboxDraft>, commit: boolean) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (commit) void save(next);
  };

  if (loadFailed && !state) {
    return (
      <ProjectSettingsSubsection title="Sandbox" settingsItem="projects.sandbox">
        <div className="flex flex-wrap items-center gap-2">
          <p className={SETTINGS_HELPER_CLASS}>The sandbox setting could not be loaded.</p>
          <Button variant="outline" size="xs" onClick={onReload}>Try again</Button>
        </div>
      </ProjectSettingsSubsection>
    );
  }

  if (!state) {
    return (
      <ProjectSettingsSubsection title="Sandbox" settingsItem="projects.sandbox">
        <p className={SETTINGS_HELPER_CLASS}>Loading…</p>
      </ProjectSettingsSubsection>
    );
  }

  const unavailable = state.mode !== 'off' && state.availability.state === 'unavailable';

  return (
    <ProjectSettingsSubsection
      title="Sandbox"
      settingsItem="projects.sandbox"
      info="Runs every session in this project inside nono, so agents reach only this project's folders, its worktrees, the extra folders below and allowed hosts. Idle sessions switch right away; a session in the middle of a turn switches when the turn ends. The setting stays on this server machine."
    >
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsChipGroup
          aria-label="Sandbox for this project"
          value={draft.mode}
          options={MODE_OPTIONS.map((option) => ({ ...option, disabled: saving }))}
          onChange={(mode) => update({ mode }, true)}
        />

        {unavailable ? (
          <p className="typography-meta text-[var(--status-error)]" role="status">
            {`Sessions in this project will not run until the sandbox is available. ${sandboxReasonText(state.availability.reason)}`}
          </p>
        ) : null}
        {saveError ? (
          <p className="typography-meta text-[var(--status-error)]" role="alert">{saveError}</p>
        ) : null}
        {localError ? (
          <p className="typography-meta text-[var(--status-error)]" role="alert">{localError}</p>
        ) : null}

        {draft.mode === 'nono' ? (
          <>
            <p className={SETTINGS_HELPER_CLASS}>
              Turning the sandbox off resets this project&apos;s trust, so Pi asks again before it loads the project&apos;s extensions.
            </p>

            <SettingsStackedField
              label="Allowed hosts"
              info="The model providers you are signed in to are allowed already. Add package registries or APIs the agent needs, one per line. For Git fetch and push over HTTPS, add the Git host, such as github.com. SSH remotes do not work in the sandbox."
              controlClassName="w-full max-w-[24rem]"
            >
              <Textarea
                value={draft.hostsText}
                onChange={(event) => update({ hostsText: event.target.value }, false)}
                onBlur={() => void save(draft)}
                placeholder="registry.npmjs.org"
                aria-label="Allowed hosts, one per line"
                rows={3}
                disabled={saving}
              />
            </SettingsStackedField>

            <SettingsStackedField
              label="Local ports"
              info="Ports on the server machine the agent may connect to, such as 8080 for a local llama.cpp server. Separate them with commas. Ports 80 and 443 are refused because they would reach any host; add the host above instead."
              controlClassName="w-full max-w-[24rem]"
            >
              <Input
                value={draft.portsText}
                onChange={(event) => update({ portsText: event.target.value }, false)}
                onBlur={() => void save(draft)}
                placeholder="8080"
                aria-label="Local ports"
                inputMode="numeric"
                className="h-8 w-full rounded-md px-3"
                disabled={saving}
              />
            </SettingsStackedField>

            <SettingsStackedField
              label="Extra folders"
              info="Folders outside the project the agent may use, such as a shared docs folder. Use full paths on the server machine."
              controlClassName="w-full max-w-[40rem]"
            >
              <div className="space-y-2">
                {draft.folders.map((folder, index) => (
                  <div key={index} className="flex min-w-0 items-center gap-2">
                    <Input
                      value={folder.path}
                      onChange={(event) => {
                        const folders = draft.folders.map((entry, at) => (at === index ? { ...entry, path: event.target.value } : entry));
                        update({ folders }, false);
                      }}
                      onBlur={() => void save(draft)}
                      placeholder="/home/me/docs"
                      aria-label={`Extra folder ${index + 1} path`}
                      className="h-8 min-w-0 flex-1 rounded-md px-3 font-mono"
                      disabled={saving}
                    />
                    <Select
                      value={folder.access}
                      onValueChange={(value) => {
                        const access = value as PiSandboxExtraFolder['access'];
                        const folders = draft.folders.map((entry, at) => (at === index ? { ...entry, access } : entry));
                        update({ folders }, true);
                      }}
                    >
                      <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-36 shrink-0" aria-label={`Extra folder ${index + 1} access`}>
                        <SelectValue>{(value) => FOLDER_ACCESS_LABELS[value as PiSandboxExtraFolder['access']] ?? ''}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="read">{FOLDER_ACCESS_LABELS.read}</SelectItem>
                        <SelectItem value="readWrite">{FOLDER_ACCESS_LABELS.readWrite}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={SETTINGS_ICON_BUTTON_CLASS}
                      aria-label={`Remove extra folder ${index + 1}`}
                      title="Remove folder"
                      disabled={saving}
                      onClick={() => update({ folders: draft.folders.filter((_, at) => at !== index) }, true)}
                    >
                      <Icon name="close" className="size-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="xs"
                  disabled={saving}
                  onClick={() => update({ folders: [...draft.folders, { path: '', access: 'read' }] }, false)}
                >
                  Add folder
                </Button>
              </div>
            </SettingsStackedField>
          </>
        ) : null}
      </div>
    </ProjectSettingsSubsection>
  );
};
