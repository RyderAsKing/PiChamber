import React from 'react';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitHubStatusStore } from '@/stores/useGitHubStatusStore';
import { setFilesViewShowGitignored, useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';
import {
  SettingsSection,
  SettingsControlGroup,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

export const GitSettings: React.FC = () => {
  const showGitignored = useFilesViewShowGitignored();
  const gitChangesViewMode = useUIStore((state) => state.gitChangesViewMode);
  const setGitChangesViewMode = useUIStore((state) => state.setGitChangesViewMode);

  const [isLoading, setIsLoading] = React.useState(true);
  const viewOptions = React.useMemo(
    () => [
      { id: 'flat' as const, label: "Flat list" },
      { id: 'tree' as const, label: "Tree view" },
    ],
    []
  );

  type GitSettingsPayload = {
    gitChangesViewMode?: 'flat' | 'tree';
  };

  // Load current settings
  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: GitSettingsPayload | null = null;

        // 1. Runtime settings API (desktop/embedded surfaces)
        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                data = {
                  gitChangesViewMode:
                    (settings as Record<string, unknown>).gitChangesViewMode === 'flat'
                    || (settings as Record<string, unknown>).gitChangesViewMode === 'tree'
                      ? ((settings as Record<string, unknown>).gitChangesViewMode as 'flat' | 'tree')
                      : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

        // 2. Fetch API (Web/server)
        if (!data) {
          const response = await runtimeFetch('/api/pi/ui-settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) {
            data = await response.json();
          }
        }

        if (data) {
          if (data.gitChangesViewMode === 'flat' || data.gitChangesViewMode === 'tree') {
            setGitChangesViewMode(data.gitChangesViewMode);
          }
        }

      } catch (error) {
        console.warn('Failed to load git settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setGitChangesViewMode]);

  const handleGitChangesViewModeChange = React.useCallback((mode: 'flat' | 'tree') => {
    if (mode === gitChangesViewMode) {
      return;
    }

    setGitChangesViewMode(mode);
    void updateDesktopSettings({ gitChangesViewMode: mode });
  }, [gitChangesViewMode, setGitChangesViewMode]);

  if (isLoading) {
    return null;
  }

  return (
    <>
      <SettingsSection title={"Git preferences"} divider={false}>
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsControlGroup
            settingsItem="git.changes-view"
            title={"Changes view"}
          >
            <SettingsRadioGroup aria-label={"Git changes view mode"}>
              {viewOptions.map((option) => (
                <SettingsRadioOption
                  key={option.id}
                  selected={gitChangesViewMode === option.id}
                  onSelect={() => {
                    handleGitChangesViewModeChange(option.id);
                  }}
                  label={option.label}
                  ariaLabel={`Git changes view mode: ${option.label}`}
                />
              ))}
            </SettingsRadioGroup>
          </SettingsControlGroup>

          <SettingsCheckboxRow
            settingsItem="git.gitignored-files"
            checked={showGitignored}
            onChange={setFilesViewShowGitignored}
            label={"Display gitignored files"}
            ariaLabel={"Display gitignored files"}
          />
        </div>
      </SettingsSection>
      <GitHubSettingsSection />
    </>
  );
};

const GitHubSettingsSection: React.FC = () => {
  const apis = useRuntimeAPIs();
  const github = apis.github ?? null;
  const status = useGitHubStatusStore((state) => state.status);
  const isLoadingStatus = useGitHubStatusStore((state) => state.isLoading);
  const refreshStatus = useGitHubStatusStore((state) => state.refresh);

  React.useEffect(() => {
    if (!github) return;
    void refreshStatus(github);
  }, [github, refreshStatus]);

  const handleCheckAgain = React.useCallback(() => {
    if (!github) return;
    void refreshStatus(github, { force: true });
  }, [github, refreshStatus]);

  const handleCopy = React.useCallback((command: string) => {
    void copyTextToClipboard(command).then((result) => {
      toast[result.ok ? 'success' : 'error'](result.ok ? 'Command copied' : 'Failed to copy command');
    }).catch(() => toast.error('Failed to copy command'));
  }, []);

  const hosts = status?.hosts ?? [];

  return (
    <SettingsSection
      title={"GitHub"}
      info="PiChamber uses the GitHub CLI's active account on the server. There is no sign-in inside PiChamber."
    >
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        {!github ? (
          <p className="typography-ui text-muted-foreground" data-settings-item="git.github-status">
            GitHub is not available in this runtime.
          </p>
        ) : !status && isLoadingStatus ? (
          <p className="typography-ui text-muted-foreground" data-settings-item="git.github-status">
            Checking GitHub CLI…
          </p>
        ) : !status ? (
          <div className="space-y-2" data-settings-item="git.github-status">
            <p className="typography-ui text-muted-foreground">Could not reach the GitHub CLI.</p>
            <Button type="button" variant="outline" size="sm" onClick={handleCheckAgain}>
              <Icon name="refresh" className="size-3.5" />
              Check again
            </Button>
          </div>
        ) : (
          <>
            <SettingsFieldRow
              label="GitHub CLI"
              info="Version reported by gh on the machine running PiChamber."
              settingsItem="git.github-status"
            >
              <span className="typography-ui text-foreground">
                {status.installed ? `Installed${status.version ? ` · ${status.version}` : ''}` : 'Not installed'}
              </span>
            </SettingsFieldRow>
            {hosts.length === 0 ? (
              <p className="typography-ui text-muted-foreground" data-settings-item="git.github-account">
                No signed-in hosts. Run gh auth login on the machine running PiChamber, then check again.
              </p>
            ) : (
              hosts.map((host) => (
                <SettingsFieldRow
                  key={host.host}
                  label={host.host}
                  info="Token scopes reported by gh for this host."
                  settingsItem="git.github-account"
                >
                  <span className="typography-ui text-foreground">
                    {host.authenticated && host.login ? `@${host.login}` : 'Not signed in'}
                    {host.scopes.length > 0 ? ` · ${host.scopes.join(', ')}` : ''}
                  </span>
                </SettingsFieldRow>
              ))
            )}
            <div data-settings-item="git.github-scopes" className="space-y-2">
              <p className="typography-ui text-muted-foreground">
                Missing scopes show in place with the exact refresh command. Example:
              </p>
              <span className="inline-flex items-center gap-1.5">
                <code className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono typography-micro text-foreground">
                  gh auth refresh -s repo
                </code>
                <button
                  type="button"
                  onClick={() => handleCopy('gh auth refresh -s repo')}
                  className="rounded p-1 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                  title="Copy gh auth refresh command"
                  aria-label="Copy gh auth refresh command"
                >
                  <Icon name="file-copy" className="size-3.5" />
                </button>
              </span>
            </div>
            <div data-settings-item="git.github-check-again">
              <Button type="button" variant="outline" size="sm" onClick={handleCheckAgain} disabled={isLoadingStatus}>
                <Icon name="refresh" className="size-3.5" />
                {isLoadingStatus ? 'Checking…' : 'Check again'}
              </Button>
            </div>
          </>
        )}
        <p className="typography-ui text-muted-foreground">
          git push uses your normal git credentials. PiChamber never changes git or gh configuration.
        </p>
      </div>
    </SettingsSection>
  );
};
