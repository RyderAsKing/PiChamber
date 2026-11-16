import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsCheckboxRow,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { reportSettingsSaveState } from '@/lib/persistence';
import { sandboxReasonText } from '@/lib/pi/sandboxText';
import type { PiSandboxDefaults, PiSandboxDefaultsUpdate, PiSandboxLauncherStatus } from '@/lib/pi/protocol';
import { useProjectSandboxStore } from '@/stores/useProjectSandboxStore';
import { HOST_PRESETS, hasPreset, parseHosts, withPreset } from './projectSandboxDraft';

const launcherStatusText = (launcher: PiSandboxLauncherStatus): string => {
  if (launcher.available) {
    return launcher.version ? `Available, version ${launcher.version}` : 'Available';
  }
  return sandboxReasonText(launcher.reason);
};

type SandboxDefaultsInput = PiSandboxDefaultsUpdate;

/** Server-level sandboxing (#242): whether each launcher can run on the
 *  server machine, with a re-check, and the default every project follows
 *  unless it chose On or Off: sandboxed or not, and hosts for all projects. */
export const SandboxingSection: React.FC = () => {
  const launchers = useProjectSandboxStore((store) => store.launchers);
  const launchersStatus = useProjectSandboxStore((store) => store.launchersStatus);
  const rechecking = useProjectSandboxStore((store) => store.rechecking);
  const loadLaunchers = useProjectSandboxStore((store) => store.loadLaunchers);
  const recheck = useProjectSandboxStore((store) => store.recheck);
  const defaults = useProjectSandboxStore((store) => store.defaults);
  const defaultsStatus = useProjectSandboxStore((store) => store.defaultsStatus);
  const savingDefaults = useProjectSandboxStore((store) => store.savingDefaults);
  const defaultsError = useProjectSandboxStore((store) => store.defaultsError);
  const loadDefaults = useProjectSandboxStore((store) => store.loadDefaults);
  const saveDefaults = useProjectSandboxStore((store) => store.saveDefaults);

  React.useEffect(() => {
    if (launchersStatus === 'idle') void loadLaunchers();
  }, [launchersStatus, loadLaunchers]);
  // Reload on every mount so a page left open never edits a stale copy; the
  // previous answer stays on screen meanwhile.
  React.useEffect(() => {
    void loadDefaults();
  }, [loadDefaults]);

  const onSaveDefaults = React.useCallback(async (next: SandboxDefaultsInput) => {
    const current = useProjectSandboxStore.getState().defaults;
    // An unreadable stored default is repaired by saving, even unchanged.
    const unchanged = (next.mode === undefined || next.mode === current?.mode)
      && (next.allowHosts === undefined || JSON.stringify(next.allowHosts) === JSON.stringify(current?.allowHosts));
    if (current && !current.invalid && unchanged) return;
    reportSettingsSaveState('saving');
    const saved = await saveDefaults(next);
    reportSettingsSaveState(saved ? 'saved' : 'error');
  }, [saveDefaults]);

  return (
    <SandboxingSectionView
      launchers={launchers}
      loadFailed={launchersStatus === 'failed'}
      rechecking={rechecking}
      onRecheck={() => void recheck()}
      defaults={defaults}
      defaultsLoadFailed={defaultsStatus === 'failed'}
      savingDefaults={savingDefaults}
      defaultsError={defaultsError}
      onSaveDefaults={onSaveDefaults}
    />
  );
};

interface SandboxingSectionViewProps {
  launchers: PiSandboxLauncherStatus[] | null;
  loadFailed: boolean;
  rechecking: boolean;
  onRecheck: () => void;
  defaults?: PiSandboxDefaults | null;
  defaultsLoadFailed?: boolean;
  savingDefaults?: boolean;
  defaultsError?: string | null;
  onSaveDefaults?: (defaults: SandboxDefaultsInput) => Promise<void>;
}

export const SandboxingSectionView: React.FC<SandboxingSectionViewProps> = ({
  launchers,
  loadFailed,
  rechecking,
  onRecheck,
  defaults = null,
  defaultsLoadFailed = false,
  savingDefaults = false,
  defaultsError = null,
  onSaveDefaults,
}) => {
  const recheckButton = (
    <Button variant="outline" size="xs" disabled={rechecking} onClick={onRecheck}>
      {rechecking ? 'Checking…' : 'Check again'}
    </Button>
  );

  return (
    <SettingsSection
      title="Sandboxing"
      settingsItem="projects.sandboxing"
      info="A sandboxed project runs its sessions inside nono, so agents reach only that project's folders and allowed hosts. Only the agent is sandboxed: the terminal, Git panel and browser run outside it with your normal access."
    >
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        {loadFailed ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className={SETTINGS_HELPER_CLASS}>Sandbox status could not be loaded.</p>
            {recheckButton}
          </div>
        ) : !launchers ? (
          <p className={SETTINGS_HELPER_CLASS}>Checking…</p>
        ) : (
          launchers.map((launcher) => (
            <div key={launcher.id} className="flex min-w-0 max-w-[24rem] items-start justify-between gap-4">
              <div className="min-w-0 space-y-0.5">
                <div className={SETTINGS_FIELD_LABEL_CLASS}>{launcher.id}</div>
                <p
                  className={launcher.available
                    ? 'typography-meta text-muted-foreground'
                    : 'typography-meta text-[var(--status-error)]'}
                >
                  {launcherStatusText(launcher)}
                </p>
              </div>
              <div className="shrink-0">{recheckButton}</div>
            </div>
          ))
        )}

        {defaults && onSaveDefaults ? (
          <SandboxDefaultsFields
            defaults={defaults}
            saving={savingDefaults}
            onSave={onSaveDefaults}
          />
        ) : defaultsLoadFailed ? (
          <p className={SETTINGS_HELPER_CLASS}>The sandbox default could not be loaded.</p>
        ) : null}
        {defaults?.invalid ? (
          <p className="typography-meta text-[var(--status-error)]" role="status">
            The saved default could not be read, so projects that follow it stay sandboxed and do not run. Save it again to fix it.
          </p>
        ) : null}
        {defaultsError ? (
          <p className="typography-meta text-[var(--status-error)]" role="alert">{defaultsError}</p>
        ) : null}
      </div>
    </SettingsSection>
  );
};

interface SandboxDefaultsFieldsProps {
  defaults: PiSandboxDefaults;
  saving: boolean;
  onSave: (defaults: SandboxDefaultsInput) => Promise<void>;
}

const SandboxDefaultsFields: React.FC<SandboxDefaultsFieldsProps> = ({ defaults, saving, onSave }) => {
  const [hostsText, setHostsText] = React.useState(() => defaults.allowHosts.join('\n'));
  const savedHosts = defaults.allowHosts.join('\n');
  // Take the server's answer whenever it changes (load, save, another device).
  React.useEffect(() => {
    setHostsText(savedHosts);
  }, [savedHosts]);

  const hosts = parseHosts(hostsText);
  const addPreset = (preset: readonly string[]) => {
    const next = withPreset(hosts, preset);
    setHostsText(next.join('\n'));
    void onSave(defaults.invalid ? { mode: defaults.mode, allowHosts: next } : { allowHosts: next });
  };

  return (
    <>
      <SettingsCheckboxRow
        checked={defaults.mode === 'nono'}
        disabled={saving}
        onChange={(checked) => {
          const mode = checked ? 'nono' : 'off';
          void onSave(defaults.invalid ? { mode, allowHosts: hosts } : { mode });
        }}
        label="Sandbox projects by default"
        info="Projects set to Default in their Sandbox settings follow this, including folders you add later. Projects set to On or Off keep their own choice. Turning it off resets the trust of every project that was sandboxed by it."
        settingsItem="projects.sandbox-default"
      />

      <SettingsStackedField
        label="Allowed hosts for all projects"
        info="Hosts every sandboxed project's agent may reach, on top of your model providers and each project's own hosts. One per line. Each host lets the agent send data there, so add only what your projects need."
        settingsItem="projects.sandbox-default-hosts"
        controlClassName="w-full max-w-[24rem] flex-col items-stretch"
      >
        <Textarea
          value={hostsText}
          onChange={(event) => setHostsText(event.target.value)}
          onBlur={() => void onSave(defaults.invalid ? { mode: defaults.mode, allowHosts: hosts } : { allowHosts: hosts })}
          placeholder="registry.npmjs.org"
          aria-label="Allowed hosts for all projects, one per line"
          rows={3}
          className="min-h-0 font-mono"
          disabled={saving}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={saving || hasPreset(hosts, HOST_PRESETS.github)}
            title={HOST_PRESETS.github.join(', ')}
            onClick={() => addPreset(HOST_PRESETS.github)}
          >
            Add GitHub
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={saving || hasPreset(hosts, HOST_PRESETS.registries)}
            title={HOST_PRESETS.registries.join(', ')}
            onClick={() => addPreset(HOST_PRESETS.registries)}
          >
            Add package registries
          </Button>
        </div>
      </SettingsStackedField>
    </>
  );
};
