import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import { reportSettingsSaveState } from '@/lib/persistence';
import { sandboxLimitText, sandboxReasonText } from '@/lib/pi/sandboxText';
import type { PiSandboxDefaults, PiSandboxDefaultsUpdate, PiSandboxLauncherStatus, PiSandboxProfile } from '@/lib/pi/protocol';
import { useProjectSandboxStore } from '@/stores/useProjectSandboxStore';
import { HOST_PRESETS, hasPreset, parseHosts, withPreset } from './projectSandboxDraft';
import { SandboxProfileFields } from './SandboxProfileFields';
import { sandboxLimitsAccepted, sandboxLimitsUpdate } from './sandboxLimits';

const launcherStatusText = (launcher: PiSandboxLauncherStatus): string => {
  if (launcher.available) {
    return launcher.version ? `Available, version ${launcher.version}` : 'Available';
  }
  return sandboxReasonText(launcher.reason);
};

type SandboxDefaultsInput = PiSandboxDefaultsUpdate;

const NONO_URL = 'https://nono.sh';

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
  const profile = useProjectSandboxStore((store) => store.profile);
  const savingProfile = useProjectSandboxStore((store) => store.savingProfile);
  const profileErrors = useProjectSandboxStore((store) => store.profileErrors);
  const loadProfile = useProjectSandboxStore((store) => store.loadProfile);
  const saveProfile = useProjectSandboxStore((store) => store.saveProfile);
  const resetProfile = useProjectSandboxStore((store) => store.resetProfile);
  // The profile matters once a project runs under it; a custom one is shown
  // regardless, so it can always be found and removed.
  const anySandboxed = useProjectSandboxStore((store) => Object.values(store.projects).some((project) => project.mode !== 'off'));

  React.useEffect(() => {
    if (launchersStatus === 'idle') void loadLaunchers();
  }, [launchersStatus, loadLaunchers]);
  // Reload on every mount so a page left open never edits a stale copy; the
  // previous answer stays on screen meanwhile.
  React.useEffect(() => {
    void loadDefaults();
    void loadProfile();
  }, [loadDefaults, loadProfile]);

  const onSaveProfile = React.useCallback(async (content: string) => {
    reportSettingsSaveState('saving');
    const saved = await saveProfile(content);
    reportSettingsSaveState(saved ? 'saved' : 'error');
    return saved;
  }, [saveProfile]);
  const onResetProfile = React.useCallback(async () => {
    reportSettingsSaveState('saving');
    const saved = await resetProfile();
    reportSettingsSaveState(saved ? 'saved' : 'error');
    return saved;
  }, [resetProfile]);

  const onSaveDefaults = React.useCallback(async (next: SandboxDefaultsInput) => {
    const current = useProjectSandboxStore.getState().defaults;
    // An unreadable stored default is repaired by saving, even unchanged.
    const unchanged = (next.mode === undefined || next.mode === current?.mode)
      && (next.allowHosts === undefined || JSON.stringify(next.allowHosts) === JSON.stringify(current?.allowHosts))
      && (next.acceptedLimits === undefined || JSON.stringify(next.acceptedLimits) === JSON.stringify(current?.acceptedLimits ?? []));
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
      profile={profile && (anySandboxed || profile.custom) ? profile : null}
      savingProfile={savingProfile}
      profileErrors={profileErrors}
      onSaveProfile={onSaveProfile}
      onResetProfile={onResetProfile}
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
  /** The launcher profile, once a project is sandboxed or a custom one exists. */
  profile?: PiSandboxProfile | null;
  savingProfile?: boolean;
  profileErrors?: string[];
  onSaveProfile?: (content: string) => Promise<boolean>;
  onResetProfile?: () => Promise<boolean>;
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
  profile = null,
  savingProfile = false,
  profileErrors = [],
  onSaveProfile,
  onResetProfile,
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
            <React.Fragment key={launcher.id}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={SETTINGS_FIELD_LABEL_CLASS}>{launcher.id}</span>
                  <p
                    className={launcher.available
                      ? 'typography-meta text-muted-foreground'
                      : 'typography-meta text-[var(--status-error)]'}
                  >
                    {launcherStatusText(launcher)}
                  </p>
                  {launcher.id === 'nono' ? (
                    <a
                      href={NONO_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="typography-meta text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                    >
                      nono.sh
                    </a>
                  ) : null}
                </div>
                <div className="shrink-0">{recheckButton}</div>
              </div>
              {launcher.available && launcher.limits && launcher.limits.length > 0 ? (
                <SandboxLimitsFields
                  limits={launcher.limits}
                  accepted={sandboxLimitsAccepted(launcher, defaults)}
                  disabled={savingDefaults || !defaults || defaults.invalid === true || !onSaveDefaults}
                  onChange={(accept) => {
                    if (!defaults || defaults.invalid || !onSaveDefaults) return;
                    void onSaveDefaults(sandboxLimitsUpdate(launcher.limits ?? [], accept));
                  }}
                />
              ) : null}
            </React.Fragment>
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
            The saved default could not be read, so projects that follow it stay sandboxed and do not run. Turn "Sandbox projects by default" on or off to save it again; the hosts and limits can be changed after that.
          </p>
        ) : null}
        {defaultsError ? (
          <p className="typography-meta text-[var(--status-error)]" role="alert">{defaultsError}</p>
        ) : null}
        {profile && onSaveProfile && onResetProfile ? (
          <SandboxProfileFields
            profile={profile}
            saving={savingProfile}
            errors={profileErrors}
            onSave={onSaveProfile}
            onReset={onResetProfile}
          />
        ) : null}
      </div>
    </SettingsSection>
  );
};

interface SandboxLimitsFieldsProps {
  limits: string[];
  accepted: boolean;
  disabled: boolean;
  onChange: (accept: boolean) => void;
}

/** What the sandbox cannot enforce on this server (WSL2), kept visible, and
 *  the owner's acceptance, without which sandboxed projects do not run. */
const SandboxLimitsFields: React.FC<SandboxLimitsFieldsProps> = ({ limits, accepted, disabled, onChange }) => (
  <SettingsControlGroup
    title="Not enforced on this server"
    description="File access is still limited, so the sandbox stops an agent's mistakes, but not code that sets out to escape it."
    contentClassName="space-y-4"
  >
    <div className="grid grid-cols-1 gap-x-10 gap-y-3 @3xl:grid-cols-2">
      {limits.map((limit) => {
        const { title, text } = sandboxLimitText(limit);
        return (
          <div key={limit} className="min-w-0 space-y-0.5">
            <p className="typography-meta font-medium text-[var(--status-warning)]">{title}</p>
            <p className={cn(SETTINGS_HELPER_CLASS, 'text-pretty')}>{text}</p>
          </div>
        );
      })}
    </div>
    <div className="space-y-1">
      <SettingsCheckboxRow
        checked={accepted}
        disabled={disabled}
        onChange={onChange}
        label={limits.length === 1 ? 'Use sandboxing with this limit' : 'Use sandboxing with these limits'}
      />
      {!accepted ? (
        <p className={SETTINGS_HELPER_CLASS}>
          {limits.length === 1
            ? 'Sandboxed projects do not run on this server until you accept it.'
            : 'Sandboxed projects do not run on this server until you accept them.'}
        </p>
      ) : null}
    </div>
  </SettingsControlGroup>
);

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
    saveHosts(next);
  };
  // The mode shown for an unreadable stored default is a placeholder, not a
  // choice: hosts are saved with the mode once the owner picks one.
  const saveHosts = (next: string[]) => {
    if (!defaults.invalid) void onSave({ allowHosts: next });
  };

  return (
    <SettingsTwoColumn className="pt-2">
      <div className="min-w-0">
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
      </div>

      <SettingsStackedField
        label="Allowed hosts for all projects"
        info="Hosts every sandboxed project's agent may reach, on top of your model providers and each project's own hosts. One per line. Each host lets the agent send data there, so add only what your projects need."
        settingsItem="projects.sandbox-default-hosts"
        controlClassName="w-full max-w-[32rem] flex-col items-stretch"
      >
        <Textarea
          value={hostsText}
          onChange={(event) => setHostsText(event.target.value)}
          onBlur={() => saveHosts(hosts)}
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
    </SettingsTwoColumn>
  );
};
