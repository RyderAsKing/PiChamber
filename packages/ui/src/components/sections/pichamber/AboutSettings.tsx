import React from 'react';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useDeviceInfo } from '@/lib/device';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { InstanceServiceUrls } from './InstanceServiceUrls';
import {
  SettingsSection,
  SETTINGS_BRAND_TITLE_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
} from '@/components/sections/shared/SettingsSection';

const GITHUB_URL = 'https://github.com/RyderAsKing/PiChamber';
const DISCORD_URL = 'https://github.com/RyderAsKing/PiChamber/discussions';
const PI_URL = 'https://pi.dev/';

const MIN_CHECKING_DURATION = 800; // ms

type AboutSettingsProps = {
  initialUpdateDialogOpen?: boolean;
};

export const AboutSettings: React.FC<AboutSettingsProps> = ({ initialUpdateDialogOpen = false }) => {
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(initialUpdateDialogOpen);
  const [showChecking, setShowChecking] = React.useState(false);
  const [piChamberVersion, setPiChamberVersion] = React.useState<string | null>(null);
  const updateStore = useUpdateStore(useShallow((s) => ({
    info: s.info,
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
  const { isMobile } = useDeviceInfo();

  const currentVersion = piChamberVersion || updateStore.info?.currentVersion || 'unknown';

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
        if (didInitiateCheck.current && !updateStore.available && !updateStore.error) {
          toast.success("You are on the latest version");
          didInitiateCheck.current = false;
        }
      }, MIN_CHECKING_DURATION);
      return () => clearTimeout(timer);
    }
  }, [ updateStore.checking, showChecking, updateStore.available, updateStore.error]);

  const isChecking = updateStore.checking || showChecking;

  if (isMobile) {
    return (
      <div className="w-full space-y-6 pb-2">
        <div className="flex flex-col items-center text-center">
          <PiChamberLogo width={72} height={72} />
          <h2 className={`mt-4 ${SETTINGS_BRAND_TITLE_CLASS}`}>PiChamber</h2>
          <div className="mt-2 space-y-1 typography-ui text-muted-foreground">
            <p>{`PiChamber version ${currentVersion}`}</p>
          </div>
          <InstanceServiceUrls />
        </div>

        <div className="flex justify-center">
          {!updateStore.available && !updateStore.error && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => updateStore.checkForUpdates()}
              disabled={isChecking}
              className="h-10 w-auto justify-center gap-2 rounded-xl px-4"
            >
              {isChecking ? <Icon name="loader" className="size-4 animate-spin" /> : <Icon name="refresh" className="size-4" />}
              {isChecking ? "Checking..." : "Check for updates"}
            </Button>
          )}

          {!isChecking && updateStore.available && (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => setUpdateDialogOpen(true)}
              className="h-10 w-auto justify-center gap-2 rounded-xl px-4"
            >
              <Icon name="download" className="size-4" />
              {`Update to ${updateStore.info?.version || ''}`}
            </Button>
          )}
        </div>

        {updateStore.error && (
          <p className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {updateStore.error}
          </p>
        )}

        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center gap-5">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="github-fill" className="size-5" />
              <span>GitHub</span>
            </a>

            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="discord-fill" className="size-5" />
              <span>Discord</span>
            </a>
          </div>

          <a href={PI_URL} target="_blank" rel="noopener noreferrer" className="typography-ui-label text-muted-foreground transition-colors hover:text-foreground">
            Pi Agent at pi.dev
          </a>
        </div>

        <AboutDetails />

        <p className="text-center typography-ui text-muted-foreground/60">
          {"Made with care for the community"}
        </p>

        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          info={updateStore.info}
          downloading={updateStore.downloading}
          downloaded={updateStore.downloaded}
          progress={updateStore.progress}
          error={updateStore.error}
          onDownload={updateStore.downloadUpdate}
          onRestart={updateStore.restartToUpdate}
          runtimeType={updateStore.runtimeType}
        />
      </div>
    );
  }

  // Desktop layout
  return (
    <>
      <SettingsSection divider={false}>
        <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        <div className="flex flex-col @xl:flex-row @xl:items-center justify-between gap-4 px-4 py-3 border-b border-border/40">
          <div className="flex min-w-0 flex-col">
            <span className={SETTINGS_FIELD_LABEL_CLASS}>{"Version"}</span>
            <span className="typography-meta text-muted-foreground font-mono">{currentVersion}</span>
          </div>
          
          <div className="flex items-center gap-3">
            {updateStore.checking && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon name="loader" className="h-4 w-4 animate-spin" />
                <span className="typography-meta">{"Checking..."}</span>
              </div>
            )}

            {!updateStore.checking && updateStore.available && (
              <Button size="sm"
                variant="default"
                onClick={() => setUpdateDialogOpen(true)}
              >
                <Icon name="download" className="h-4 w-4 mr-1" />
                {`Update to ${updateStore.info?.version || ''}`}
              </Button>
            )}

            {!updateStore.checking && !updateStore.available && !updateStore.error && (
              <span className="typography-meta text-muted-foreground">{"Up to date"}</span>
            )}

            <Button size="sm"
              variant="outline"
              onClick={() => updateStore.checkForUpdates()}
              disabled={updateStore.checking}
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

        <div className="flex flex-col gap-2 border-b border-border/40 px-4 py-3 @xl:flex-row @xl:items-center @xl:justify-between">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>{"Instance URLs"}</span>
          <InstanceServiceUrls />
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
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          info={updateStore.info}
          downloading={updateStore.downloading}
          downloaded={updateStore.downloaded}
          progress={updateStore.progress}
          error={updateStore.error}
          onDownload={updateStore.downloadUpdate}
          onRestart={updateStore.restartToUpdate}
          runtimeType={updateStore.runtimeType}
        />
      </SettingsSection>
      <AboutDetails />
    </>
  );
};

const AboutDetails: React.FC = () => (
  <>
    <SettingsSection title="What is PiChamber" divider={false}>
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
          Thank you to Pierre, the Pi community, Ghostty-web, and every contributor whose work,
          feedback, and ideas help make this project possible.
        </p>
      </div>
    </SettingsSection>

    <SettingsSection title="Links and license">
      <div className="flex flex-wrap gap-x-5 gap-y-2 typography-ui-label">
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-muted-foreground transition-colors hover:text-foreground">
          PiChamber on GitHub
        </a>
        <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="text-muted-foreground transition-colors hover:text-foreground">
          GitHub discussions
        </a>
        <a href="https://github.com/RyderAsKing/PiChamber/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="text-muted-foreground transition-colors hover:text-foreground">
          MIT license
        </a>
      </div>
    </SettingsSection>
  </>
);
