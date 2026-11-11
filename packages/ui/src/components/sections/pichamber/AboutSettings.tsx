import React from 'react';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import type { UpdateInfo } from '@/lib/desktop';
import { InstanceServiceUrls } from './InstanceServiceUrls';
import { UpdateChannelSettings } from './UpdateChannelSettings';
import {
  SettingsSection,
  SETTINGS_FIELD_LABEL_CLASS,
} from '@/components/sections/shared/SettingsSection';

const GITHUB_URL = 'https://github.com/RyderAsKing/PiChamber';
const PI_URL = 'https://pi.dev/';

const MIN_CHECKING_DURATION = 800; // ms

declare const __APP_VERSION__: string | undefined;

type UpdateTarget = 'client' | 'server';

type AboutSettingsProps = {
  initialUpdateDialogOpen?: boolean;
};

export const AboutSettings: React.FC<AboutSettingsProps> = ({ initialUpdateDialogOpen = false }) => {
  const [updateDialogTarget, setUpdateDialogTarget] = React.useState<UpdateTarget | null>(
    initialUpdateDialogOpen ? 'client' : null,
  );
  const [showChecking, setShowChecking] = React.useState(false);
  const [piChamberVersion, setPiChamberVersion] = React.useState<string | null>(null);
  const updateStore = useUpdateStore(useShallow((s) => ({
    info: s.info,
    serverInfo: s.serverInfo,
    checking: s.checking,
    available: s.available,
    error: s.error,
    downloading: s.downloading,
    downloaded: s.downloaded,
    progress: s.progress,
    runtimeType: s.runtimeType,
    checkForUpdates: s.checkForUpdates,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate,
  })));
  const isRemoteDesktop = isElectronShell() && !isDesktopLocalOriginActive();
  // The native app is its own bundle, connected to a separately versioned
  // server. Hosted mobile is served by that server, so it has one version.
  const isNativeMobile = React.useMemo(() => isCapacitorApp(), []);
  const hasSeparateServer = isRemoteDesktop || isNativeMobile;
  const currentVersion = piChamberVersion || updateStore.info?.currentVersion || 'unknown';
  const clientVersion = updateStore.info?.currentVersion
    || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown');
  const serverVersion = updateStore.serverInfo?.currentVersion || piChamberVersion || 'unknown';
  const clientUpdateAvailable = updateStore.available;
  const serverUpdateAvailable = hasSeparateServer && (updateStore.serverInfo?.available ?? false);
  const anyUpdateAvailable = clientUpdateAvailable || serverUpdateAvailable;
  const activeUpdateInfo = updateDialogTarget === 'server'
    ? updateStore.serverInfo
    : updateStore.info;
  const activeRuntimeType = updateDialogTarget === 'server'
    ? 'web'
    : updateStore.runtimeType;

  React.useEffect(() => {
    let cancelled = false;

    const loadPiChamberVersion = async () => {
      try {
        const response = await runtimeFetch('/api/system/info', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null) as { pichamberVersion?: unknown } | null;
        const version = typeof data?.pichamberVersion === 'string' && data.pichamberVersion.trim().length > 0
          ? data.pichamberVersion.trim()
          : null;
        if (!cancelled) setPiChamberVersion(version);
      } catch {
        if (!cancelled) setPiChamberVersion(null);
      }
    };

    void loadPiChamberVersion();

    return () => {
      cancelled = true;
    };
  }, []);


  // Track if we initiated a check to show toast on completion
  const didInitiateCheck = React.useRef(false);

  // Ensure minimum visible duration for checking animation
  React.useEffect(() => {
    if (updateStore.checking) {
      setShowChecking(true);
      didInitiateCheck.current = true;
    } else if (showChecking) {
      const timer = setTimeout(() => {
        setShowChecking(false);
        // Show toast if check completed with no update available
        if (didInitiateCheck.current) {
          // A failed check returns no result; it must not read as "up to date".
          const { info, serverInfo } = useUpdateStore.getState();
          const checkComplete = info !== null && (!hasSeparateServer || serverInfo !== null);
          if (!anyUpdateAvailable && !updateStore.error && checkComplete) {
            toast.success("You are on the latest version");
          }
          didInitiateCheck.current = false;
        }
      }, MIN_CHECKING_DURATION);
      return () => clearTimeout(timer);
    }
  }, [updateStore.checking, showChecking, anyUpdateAvailable, updateStore.error, hasSeparateServer]);

  const isChecking = updateStore.checking || showChecking;

  // One layout on every runtime; its rows stack in a narrow pane such as a phone.
  return (
    <>
      <SettingsSection divider={false}>
        <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        {/* One line at every width: the version and its status on the left,
            the actions on the right, so a phone reads it like desktop. */}
        <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border/40">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={SETTINGS_FIELD_LABEL_CLASS}>{"Version"}</span>
            {hasSeparateServer ? (
              <div className="flex flex-wrap items-center gap-x-2 typography-meta text-muted-foreground">
                <AboutVersionTarget
                  label="Client"
                  version={clientVersion}
                  updateInfo={updateStore.info}
                  onOpen={() => setUpdateDialogTarget('client')}
                />
                <span className="text-subtle-foreground" aria-hidden="true">·</span>
                <AboutVersionTarget
                  label="Server"
                  version={serverVersion}
                  updateInfo={updateStore.serverInfo}
                  onOpen={() => setUpdateDialogTarget('server')}
                />
              </div>
            ) : (
              <span className="typography-meta text-muted-foreground font-mono">{currentVersion}</span>
            )}
            {isChecking ? (
              <span className="flex items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name="loader" className="size-3.5 animate-spin" aria-hidden="true" />
                {"Checking..."}
              </span>
            ) : hasSeparateServer && anyUpdateAvailable ? (
              <span className="typography-meta text-[var(--primary-base)]">{"Updates available"}</span>
            ) : !anyUpdateAvailable && !updateStore.error ? (
              <span className="typography-meta text-muted-foreground">{"Up to date"}</span>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2 @xl:flex-row @xl:items-center">
            {!isChecking && !hasSeparateServer && updateStore.available && (
              <Button size="sm"
                variant="default"
                onClick={() => setUpdateDialogTarget('client')}
              >
                <Icon name="download" className="h-4 w-4 mr-1" />
                {`Update to ${updateStore.info?.version || ''}`}
              </Button>
            )}

            <Button size="sm"
              variant="outline"
              onClick={() => updateStore.checkForUpdates()}
              disabled={isChecking}
            >
              {"Check for updates"}
            </Button>
          </div>
        </div>
        
        {updateStore.error && (
          <div className="px-3 py-2 border-b border-border/40">
            <p className="typography-meta text-[var(--status-error)]">{updateStore.error}</p>
          </div>
        )}

        {/* Label and addresses share a line, wrapping only when an address doesn't fit. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/40 px-4 py-3">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>{"Instance URLs"}</span>
          <InstanceServiceUrls className="min-w-0 justify-end" />
        </div>

        <div className="flex items-center gap-4 px-4 py-4">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground typography-meta transition-colors"
          >
            <Icon name="github-fill" className="h-4 w-4" />
            <span>GitHub</span>
          </a>

            <a
              href={PI_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground typography-meta transition-colors"
            >
              <Icon name="information" className="h-4 w-4" />
              <span>Pi Agent</span>
            </a>
          </div>
        </div>

        <UpdateDialog
          open={updateDialogTarget !== null}
          onOpenChange={(open) => { if (!open) setUpdateDialogTarget(null); }}
          info={activeUpdateInfo}
          downloading={updateDialogTarget === 'client' && updateStore.downloading}
          downloaded={updateDialogTarget === 'client' && updateStore.downloaded}
          progress={updateDialogTarget === 'client' ? updateStore.progress : null}
          error={updateStore.error}
          onDownload={updateStore.downloadUpdate}
          onRestart={updateStore.restartToUpdate}
          runtimeType={activeRuntimeType}
        />
      </SettingsSection>
      <UpdateChannelSettings />
      <AboutDetails />
    </>
  );
};

type AboutVersionTargetProps = {
  label: 'Client' | 'Server';
  version: string;
  updateInfo: UpdateInfo | null;
  onOpen: () => void;
};

const AboutVersionTarget: React.FC<AboutVersionTargetProps> = ({
  label,
  version,
  updateInfo,
  onOpen,
}) => {
  if (!updateInfo?.available) {
    return <span className="font-mono">{`${label} ${version}`}</span>;
  }

  const updaterLabel = `Open ${label.toLowerCase()} updater${updateInfo.version ? ` for ${updateInfo.version}` : ''}`;
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onOpen}
      className="normal-case font-mono text-[var(--primary-base)]"
      aria-label={updaterLabel}
      title={updaterLabel}
    >
      <span>{`${label} ${version}`}</span>
      <Icon name="arrow-up" className="size-3.5" aria-hidden="true" />
    </Button>
  );
};

const AboutDetails: React.FC = () => (
  <>
    <SettingsSection title="What is PiChamber">
      <div className="max-w-2xl space-y-3 typography-ui text-muted-foreground">
        <p>
          PiChamber is an open-source workspace for running and supervising Pi Coding Agent
          sessions from a desktop app or browser.
        </p>
        <p>
          It keeps the Pi session daemon on your host while giving trusted devices a focused,
          authenticated interface for creating sessions, following live work, and steering the
          agent when needed.
        </p>
      </div>
    </SettingsSection>

    <SettingsSection title="Our goals">
      <ul className="max-w-2xl list-disc space-y-2 pl-5 typography-ui text-muted-foreground">
        <li>Make agent-assisted development practical from anywhere you work.</li>
        <li>Keep users in control of sessions, tools, project context, and credentials.</li>
        <li>Offer a calm, responsive interface for both focused coding and supervision.</li>
        <li>Stay open, self-hostable, and respectful of the systems where Pi runs.</li>
      </ul>
    </SettingsSection>

    <SettingsSection title="Built around Pi">
      <div className="max-w-2xl space-y-3 typography-ui text-muted-foreground">
        <p>
          Pi is the coding agent and session engine underneath PiChamber. It is designed for
          working with your tools and code directly, and PiChamber adds the multi-device workspace
          around that experience.
        </p>
        <p>
          Learn more about Pi Coding Agent at{' '}
          <a href={PI_URL} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:text-primary">
            pi.dev
          </a>
          .
        </p>
      </div>
    </SettingsSection>

    <SettingsSection title="Special thanks">
      <div className="max-w-2xl space-y-3 typography-ui text-muted-foreground">
        <p>
          PiChamber is a community fork of{' '}
          <a href="https://github.com/openchamber/openchamber" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:text-primary">
            OpenChamber
          </a>
          {' '}by Bohdan Triapitsyn. We are grateful for the foundation and the required MIT
          attribution carried forward from that project.
        </p>
        <p>
          Thank you to Pierre, the Pi community, xterm.js, and every contributor whose work,
          feedback, and ideas help make this project possible.
        </p>
      </div>
    </SettingsSection>

    <SettingsSection title="Links and license">
      <div className="flex flex-wrap gap-x-5 gap-y-2 typography-ui-label">
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-muted-foreground transition-colors hover:text-foreground">
          PiChamber on GitHub
        </a>
        <a href="https://github.com/RyderAsKing/PiChamber/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="text-muted-foreground transition-colors hover:text-foreground">
          MIT license
        </a>
      </div>
    </SettingsSection>
  </>
);
