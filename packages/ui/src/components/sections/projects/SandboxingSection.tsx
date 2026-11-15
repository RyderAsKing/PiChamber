import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsSection, SETTINGS_FIELD_LABEL_CLASS, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { sandboxReasonText } from '@/lib/pi/sandboxText';
import type { PiSandboxLauncherStatus } from '@/lib/pi/protocol';
import { useProjectSandboxStore } from '@/stores/useProjectSandboxStore';

const launcherStatusText = (launcher: PiSandboxLauncherStatus): string => {
  if (launcher.available) {
    return launcher.version ? `Available, version ${launcher.version}` : 'Available';
  }
  return sandboxReasonText(launcher.reason);
};

/** Server-level sandboxing status (#242): whether each launcher can run on
 *  the server machine, with a re-check. Projects turn it on one by one. */
export const SandboxingSection: React.FC = () => {
  const launchers = useProjectSandboxStore((store) => store.launchers);
  const launchersStatus = useProjectSandboxStore((store) => store.launchersStatus);
  const rechecking = useProjectSandboxStore((store) => store.rechecking);
  const loadLaunchers = useProjectSandboxStore((store) => store.loadLaunchers);
  const recheck = useProjectSandboxStore((store) => store.recheck);

  React.useEffect(() => {
    if (launchersStatus === 'idle') void loadLaunchers();
  }, [launchersStatus, loadLaunchers]);

  return (
    <SandboxingSectionView
      launchers={launchers}
      loadFailed={launchersStatus === 'failed'}
      rechecking={rechecking}
      onRecheck={() => void recheck()}
    />
  );
};

interface SandboxingSectionViewProps {
  launchers: PiSandboxLauncherStatus[] | null;
  loadFailed: boolean;
  rechecking: boolean;
  onRecheck: () => void;
}

export const SandboxingSectionView: React.FC<SandboxingSectionViewProps> = ({
  launchers,
  loadFailed,
  rechecking,
  onRecheck,
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
      info="A sandboxed project runs its sessions inside nono, so agents reach only that project's folders and allowed hosts. Turn it on for a project in its settings. The built-in terminal always runs outside the sandbox."
    >
      {loadFailed ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className={SETTINGS_HELPER_CLASS}>Sandbox status could not be loaded.</p>
          {recheckButton}
        </div>
      ) : !launchers ? (
        <p className={SETTINGS_HELPER_CLASS}>Checking…</p>
      ) : (
        <div className="space-y-3">
          {launchers.map((launcher) => (
            <div key={launcher.id} className="flex min-w-0 items-start justify-between gap-4">
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
          ))}
        </div>
      )}
    </SettingsSection>
  );
};
