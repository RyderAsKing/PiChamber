/* eslint-disable */
import React, { useEffect } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';

import { DiffIcon } from '@/components/icons/DiffIcon';
import { useUIStore, type MainTab } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { buildSessionMessageRecordsSnapshot, useDirectoryStore, useGlobalSessionStatus, useSession, useSessionMessages } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore as useDirectoryMetadataStore } from '@/stores/useDirectoryStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { streamPerfCount } from '@/stores/utils/streamDebug';

import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useDeviceInfo, useTabletLayout, useTabletStandalonePwaRuntime } from '@/lib/device';
import { MobileSessionMetadataButton } from '@/apps/MobileSessionMetadata';
import { cn, hasModifier } from '@/lib/utils';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { updateDesktopSettings } from '@/lib/persistence';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { eventMatchesShortcut, formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { getHeaderLocationLabel, getHeaderOpenDirectory } from './headerLocation';

type UsageWindow = any;
import type { GitHubAuthStatus } from '@/lib/api/types';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';

const SessionSwitcherDropdown = React.lazy(() =>
  import('@/components/session/SessionSwitcherDropdown').then((module) => ({ default: module.SessionSwitcherDropdown })),
);
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopLocalOriginActive, isDesktopShell, startDesktopWindowDrag, type UpdateInfo } from '@/lib/desktop';
import { desktopHostsGet, redactSensitiveUrl } from '@/lib/desktopHosts';
import {
  LOCAL_HOST_ID,
  buildLocalDesktopHost,
  getLocalDesktopOrigin,
  resolveCurrentDesktopHost,
} from '@/lib/desktopCurrentHost';
import { Icon } from "@/components/icon/Icon";
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useShallow } from 'zustand/react/shallow';
import type { IconName } from "@/components/icon/icons";
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';
const MOBILE_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-9 w-9 items-center justify-center gap-2 p-2 rounded-md typography-ui-label font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:text-foreground hover:bg-interactive-hover transition-colors';

type HeaderIconActionButtonProps = {
  visible?: boolean;
  title: string;
  ariaLabel: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  className?: string;
  Icon: IconName;
  iconClassName?: string;
  pressed?: boolean;
};

const HeaderIconActionButton = React.memo(function HeaderIconActionButton({
  visible = true,
  title,
  ariaLabel,
  onClick,
  className,
  Icon: iconName,
  iconClassName,
  pressed = false,
}: HeaderIconActionButtonProps) {
  if (!visible) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          aria-pressed={pressed}
          className={cn(
            className ?? DESKTOP_HEADER_ICON_BUTTON_CLASS,
            pressed && 'bg-interactive-selection text-interactive-selection-foreground'
          )}
        >
          <Icon name={iconName} className={iconClassName ?? 'h-[18px] w-[18px]'} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
  );
});

type DesktopGitHubControlProps = {
  isMobile: boolean;
  githubAuthStatus: GitHubAuthStatus | null;
  githubAccounts: Array<NonNullable<GitHubAuthStatus['accounts']>[number]>;
  githubAvatarUrl: string | null;
  githubLogin: string | null;
  isSwitchingGitHubAccount: boolean;
  handleGitHubAccountSwitch: (accountId: string) => Promise<void>;
};

const DesktopGitHubControl = React.memo(function DesktopGitHubControl({
  isMobile,
  githubAuthStatus,
  githubAccounts,
  githubAvatarUrl,
  githubLogin,
  isSwitchingGitHubAccount,
  handleGitHubAccountSwitch,
}: DesktopGitHubControlProps) {
  if (!githubAuthStatus?.connected || isMobile) {
    return null;
  }

  if (githubAccounts.length > 1) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              DESKTOP_HEADER_ICON_BUTTON_CLASS,
              'h-7 w-7 overflow-hidden rounded-full border border-border/60 bg-muted/80 p-0'
            )}
            title={githubLogin ? `GitHub: ${githubLogin}` : "GitHub connected"}
            disabled={isSwitchingGitHubAccount}
          >
            {githubAvatarUrl ? (
              <img
                src={githubAvatarUrl}
                alt={githubLogin ? `${githubLogin} avatar` : "GitHub avatar"}
                className="h-full w-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <Icon name="github-fill" className="h-3.5 w-3.5 text-foreground" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
            {"GitHub Accounts"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {githubAccounts.map((account) => {
            const accountUser = account.user;
            const isCurrent = Boolean(account.current);
            const sourceLabel = account.source === 'gh-cli'
              ? "CLI"
              : "OAuth";
            return (
              <DropdownMenuItem
                key={account.id}
                className="gap-2"
                disabled={isSwitchingGitHubAccount}
                onSelect={() => {
                  if (!isCurrent) {
                    void handleGitHubAccountSwitch(account.id);
                  }
                }}
              >
                {accountUser?.avatarUrl ? (
                  <img
                    src={accountUser.avatarUrl}
                    alt={accountUser.login ? `${accountUser.login} avatar` : "GitHub avatar"}
                    className="h-6 w-6 rounded-full border border-border/60 bg-muted object-cover"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-muted">
                    <Icon name="github-fill" className="h-3 w-3 text-muted-foreground" />
                  </div>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate typography-ui-label text-foreground">
                    {accountUser?.name?.trim() || accountUser?.login || 'GitHub'}
                  </span>
                  {accountUser?.login ? (
                    <span className="truncate typography-micro text-muted-foreground">
                      <span className="font-mono">{accountUser.login}</span>
                      <span className="mx-1 opacity-50">·</span>
                      <span>{sourceLabel}</span>
                    </span>
                  ) : null}
                </span>
                {isCurrent ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      className="app-region-no-drag flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-muted/80"
      title={githubLogin ? `GitHub: ${githubLogin}` : "GitHub connected"}
    >
      {githubAvatarUrl ? (
        <img
          src={githubAvatarUrl}
          alt={githubLogin ? `${githubLogin} avatar` : "GitHub avatar"}
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <Icon name="github-fill" className="h-3.5 w-3.5 text-foreground" />
      )}
    </div>
  );
});

type DesktopServicesMenuProps = {
  isDesktopApp: boolean;
  currentInstanceLabel: string;
  compactCurrentInstanceLabel: string;
  currentInstanceIsLocal: boolean;
  isDesktopServicesOpen: boolean;
  setIsDesktopServicesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refreshCurrentInstanceLabel: () => Promise<void>;
  shortcutLabel: (actionId: string) => string;
  remoteUpdateInfo: UpdateInfo | null;
  remoteUpdateChecking: boolean;
  remoteUpdateError: string | null;
  onOpenRemoteUpdate: () => void;
};

const DesktopServicesMenu = React.memo(function DesktopServicesMenu({
  isDesktopApp,
  currentInstanceLabel,
  compactCurrentInstanceLabel,
  currentInstanceIsLocal,
  isDesktopServicesOpen,
  setIsDesktopServicesOpen,
  refreshCurrentInstanceLabel,
  shortcutLabel,
  remoteUpdateInfo,
  remoteUpdateChecking,
  remoteUpdateError,
  onOpenRemoteUpdate,
}: DesktopServicesMenuProps) {
  return (
    <DropdownMenu
      open={isDesktopServicesOpen}
      onOpenChange={(open) => {
        setIsDesktopServicesOpen(open);
        if (open) {
          void refreshCurrentInstanceLabel();
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={isDesktopApp
                ? `Open instance, usage and MCP (current: ${currentInstanceLabel})`
                : "Open services, usage and MCP"}
              className={cn(
                DESKTOP_HEADER_ICON_BUTTON_CLASS,
                isDesktopApp ? 'w-auto max-w-[14rem] justify-start gap-1.5 px-2.5' : 'h-8 w-8'
              )}
            >
              <Icon name="server" className="h-[18px] w-[18px]" />
              {isDesktopApp ? (
                <span className="truncate typography-ui-label font-medium text-foreground">{compactCurrentInstanceLabel}</span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {`Current instance: ${currentInstanceLabel} (${shortcutLabel('toggle_services_menu')})`}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-[min(27rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto p-0"
      >
        {isDesktopApp ? (
          <div>
            {!currentInstanceIsLocal ? (
              <div className="border-b border-[var(--interactive-border)] px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="typography-ui-label font-medium text-foreground">{"Remote instance update"}</div>
                    <div className="typography-micro text-muted-foreground">
                      {remoteUpdateInfo?.available
                        ? `Version ${remoteUpdateInfo.version || ''} is available for this instance.`
                        : remoteUpdateChecking
                          ? "Looking for updates..."
                          : remoteUpdateError || "This instance is up to date."}
                    </div>
                  </div>
                  {remoteUpdateInfo?.available ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md bg-[var(--primary-base)] px-3 py-1.5 typography-ui-label font-medium text-[var(--primary-foreground)] hover:opacity-90"
                      onClick={onOpenRemoteUpdate}
                    >
                      {"Update"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <DesktopHostSwitcherDialog
              embedded
              open={isDesktopServicesOpen}
              onOpenChange={() => {}}
              onHostSwitched={() => setIsDesktopServicesOpen(false)}
            />
          </div>
        ) : null}

      </DropdownMenuContent>
    </DropdownMenu>
  );
});



const formatCompactHeaderLabel = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const first = words[0];
    const second = words[1].slice(0, 3);
    const shortTwoWord = `${first} ${second}`.trim();
    if (words.length > 2 || shortTwoWord.length < trimmed.length) {
      return `${shortTwoWord}...`;
    }
    return shortTwoWord;
  }

  return trimmed.length > 12 ? `${trimmed.slice(0, 9).trimEnd()}...` : trimmed;
};

const formatTime = (timestamp: number | null, timeFormatPreference: 'auto' | '12h' | '24h') => {
  if (!timestamp) return '-';
  try {
    return formatTimeForPreference(timestamp, timeFormatPreference, { fallback: '-' });
  } catch {
    return '-';
  }
};

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

interface TabConfig {
  id: MainTab;
  label: string;
  icon: IconName | 'diff';
  badge?: number;
  showDot?: boolean;
}

type TabletWorkspaceTab = 'changes' | 'files' | 'terminal' | 'notes';

interface HeaderProps {
  onToggleLeftDrawer?: () => void;
  onToggleRightDrawer?: () => void;
  leftDrawerOpen?: boolean;
  rightDrawerOpen?: boolean;
  tabletWorkspaceTab?: TabletWorkspaceTab;
  onSelectTabletWorkspaceTab?: (tab: TabletWorkspaceTab) => void;
}

type HeaderSessionSnapshot = {
  title: string | null;
  directory: string | null;
  created: number | null;
  slug: string | null;
  shareUrl: string | null;
  parentId: string | null;
};

export const Header: React.FC<HeaderProps> = ({
  onToggleLeftDrawer,
  onToggleRightDrawer,
  leftDrawerOpen,
  rightDrawerOpen,
  tabletWorkspaceTab,
  onSelectTabletWorkspaceTab,
}) => {
  streamPerfCount('ui.header.render');
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  const runtimeApis = useRuntimeAPIs();

  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionStatus = useGlobalSessionStatus(currentSessionId ?? '');
  const currentSessionRecord = useSession(currentSessionId);
  const currentGlobalSession = React.useMemo((): HeaderSessionSnapshot | null => {
    if (!currentSessionRecord) return null;
    const record = currentSessionRecord as typeof currentSessionRecord & { directory?: string | null; slug?: string | null };
    return {
      title: currentSessionRecord.title ?? null,
      directory: record.directory ?? null,
      created: currentSessionRecord.time?.created ?? null,
      slug: record.slug ?? null,
      shareUrl: (currentSessionRecord as { share?: { url?: string } }).share?.url ?? null,
      parentId: currentSessionRecord.parentID ?? null,
    };
  }, [currentSessionRecord]);
  const activeProject = useProjectsStore(useShallow((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId);
    return project ? { id: project.id, path: project.path, label: project.label } : null;
  }));
  const homeDirectory = useDirectoryMetadataStore((state) => state.homeDirectory);
  const activeProjectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }

    const trimmedLabel = activeProject.label?.trim();
    if (trimmedLabel) {
      return trimmedLabel;
    }

    const pathSegments = activeProject.path.split(/[\\/]/).filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? null;
  }, [activeProject]);

  const { isMobile } = useDeviceInfo();
  const { enabled: isTabletLayoutEnabled } = useTabletLayout();
  const isTabletWorkspaceMode = Boolean(isTabletLayoutEnabled && onSelectTabletWorkspaceTab && tabletWorkspaceTab !== undefined);
  const tabletWorkspaceTabs = React.useMemo<Array<{ id: TabletWorkspaceTab; label: string; icon: IconName }>>(() => [
    { id: 'changes', label: "Changes", icon: "git-branch" },
    { id: 'files', label: "Files", icon: "file-text" },
    { id: 'terminal', label: "Terminal", icon: "terminal-box" },
    { id: 'notes', label: "Notes", icon: "sticky-note" },
  ], []);
  const [tabletMetadataOpen, setTabletMetadataOpen] = React.useState(false);
  const githubAuthStatus = null;

  const headerRef = React.useRef<HTMLElement | null>(null);

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });
  const hasElectronDesktopIPC = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __PICHAMBER_MACOS_MAJOR__?: unknown }).__PICHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    // Fallback: WebKit reports "Mac OS X 10_15_7" format where 10 is legacy prefix
    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
    return first === 10 ? second : first;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
  const githubAvatarUrl = null;
  const githubLogin = null;
  const githubAccounts: any[] = [];
  const [isSwitchingGitHubAccount, setIsSwitchingGitHubAccount] = React.useState(false);
  const [isDesktopServicesOpen, setIsDesktopServicesOpen] = React.useState(false);
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');
  const [currentInstanceIsLocal, setCurrentInstanceIsLocal] = React.useState(true);
  const [remoteUpdateDialogOpen, setRemoteUpdateDialogOpen] = React.useState(false);
  const [remoteUpdateInfo, setRemoteUpdateInfo] = React.useState<UpdateInfo | null>(null);
  const [remoteUpdateChecking, setRemoteUpdateChecking] = React.useState(false);
  const [remoteUpdateError, setRemoteUpdateError] = React.useState<string | null>(null);
  const compactCurrentInstanceLabel = React.useMemo(() => formatCompactHeaderLabel(currentInstanceLabel), [currentInstanceLabel]);

  const refreshCurrentInstanceLabel = React.useCallback(async () => {
    if (typeof window === 'undefined' || !isDesktopApp) {
      return;
    }

    try {
      if (isDesktopLocalOriginActive()) {
        setCurrentInstanceLabel('Local');
        setCurrentInstanceIsLocal(true);
        return;
      }
      setCurrentInstanceIsLocal(false);

      // Same resolution the host switcher's own header uses, so the button and
      // the panel it opens can never disagree about which instance this is.
      const cfg = await desktopHostsGet();
      const localOrigin = getLocalDesktopOrigin();
      const resolved = resolveCurrentDesktopHost([buildLocalDesktopHost(localOrigin), ...cfg.hosts]);

      if (resolved.id === LOCAL_HOST_ID) {
        setCurrentInstanceLabel('Local');
        setCurrentInstanceIsLocal(true);
        return;
      }

      setCurrentInstanceLabel(redactSensitiveUrl(resolved.label.trim() || 'Instance'));
    } catch {
      setCurrentInstanceLabel('Local');
      setCurrentInstanceIsLocal(true);
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void refreshCurrentInstanceLabel();
    // Switching instances does not remount the header, so without this the
    // button would keep naming the instance the window left behind.
    return subscribeRuntimeEndpointChanged(() => {
      void refreshCurrentInstanceLabel();
    });
  }, [refreshCurrentInstanceLabel]);

  const checkRemoteInstanceUpdate = React.useCallback(async () => {
    if (currentInstanceIsLocal) {
      setRemoteUpdateInfo(null);
      setRemoteUpdateError(null);
      return;
    }

    setRemoteUpdateChecking(true);
    setRemoteUpdateError(null);
    try {
      // Status-only poll of the remote server's update feed.
      const params = new URLSearchParams({ appType: 'web', instanceMode: 'remote' });
      const response = await runtimeFetch(`/api/pi/update-check?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const data = await response.json();
      setRemoteUpdateInfo({
        available: data.available ?? false,
        version: data.version,
        currentVersion: data.currentVersion ?? 'unknown',
        body: data.body,
        nextSuggestedCheckInSec: typeof data.nextSuggestedCheckInSec === 'number' ? data.nextSuggestedCheckInSec : undefined,
        packageManager: data.packageManager,
        updateCommand: data.updateCommand,
      });
    } catch (error) {
      setRemoteUpdateInfo(null);
      setRemoteUpdateError(error instanceof Error ? error.message : "Failed to check remote instance updates");
    } finally {
      setRemoteUpdateChecking(false);
    }
  }, [currentInstanceIsLocal]);

  React.useEffect(() => {
    setRemoteUpdateInfo(null);
    setRemoteUpdateError(null);
    setRemoteUpdateDialogOpen(false);
  }, [currentInstanceIsLocal, currentInstanceLabel]);

  React.useEffect(() => {
    if (!isDesktopApp || currentInstanceIsLocal) {
      return;
    }

    const initialDelayMs = 3000;
    const intervalMs = 60 * 60 * 1000;
    let disposed = false;
    let timer: number | null = null;

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        if (disposed || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) {
          schedule(intervalMs);
          return;
        }
        void checkRemoteInstanceUpdate().finally(() => {
          if (!disposed) {
            schedule(intervalMs);
          }
        });
      }, delayMs);
    };

    schedule(initialDelayMs);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [checkRemoteInstanceUpdate, currentInstanceIsLocal, currentInstanceLabel, isDesktopApp]);

  const openRemoteInstanceUpdate = React.useCallback(() => {
    if (remoteUpdateInfo?.available) {
      setRemoteUpdateDialogOpen(true);
      return;
    }
    void checkRemoteInstanceUpdate();
  }, [checkRemoteInstanceUpdate, remoteUpdateInfo?.available]);

  const currentSessionSnapshot = currentSessionId
    ? currentGlobalSession ?? null
    : null;

  const lastResolvedSessionRef = React.useRef<{
    sessionId: string;
    session: HeaderSessionSnapshot;
    expiresAt: number;
  } | null>(null);
  const [sessionFallbackVersion, setSessionFallbackVersion] = React.useState(0);

  React.useEffect(() => {
    if (!currentSessionId) {
      if (lastResolvedSessionRef.current) {
        lastResolvedSessionRef.current = null;
        setSessionFallbackVersion((value) => value + 1);
      }
      return;
    }

    if (currentSessionSnapshot) {
      lastResolvedSessionRef.current = {
        sessionId: currentSessionId,
        session: currentSessionSnapshot,
        expiresAt: Date.now() + 2000,
      };
      return;
    }

    const cached = lastResolvedSessionRef.current;
    if (!cached || cached.sessionId !== currentSessionId) {
      return;
    }

    const remainingMs = cached.expiresAt - Date.now();
    if (remainingMs <= 0) {
      lastResolvedSessionRef.current = null;
      setSessionFallbackVersion((value) => value + 1);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (lastResolvedSessionRef.current?.sessionId === currentSessionId) {
        lastResolvedSessionRef.current = null;
      }
      setSessionFallbackVersion((value) => value + 1);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [currentSessionId, currentSessionSnapshot]);

  void sessionFallbackVersion;
  const currentSession = (() => {
    if (currentSessionSnapshot) {
      return currentSessionSnapshot;
    }

    if (!currentSessionId) {
      return null;
    }

    const cached = lastResolvedSessionRef.current;
    if (cached && cached.sessionId === currentSessionId && cached.expiresAt > Date.now()) {
      return cached.session;
    }

    return null;
  })();

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof currentSession?.directory === 'string' ? currentSession.directory : '';
    return normalize(raw || '');
  }, [currentSession?.directory]);

  const draftDirectory = useSessionUIStore((state) => {
    if (!state.newSessionDraft?.open) {
      return '';
    }
    return normalize(state.newSessionDraft.directoryOverride ?? '');
  });

  const openDirectory = React.useMemo(() => getHeaderOpenDirectory({
    sessionDirectory,
    draftDirectory,
    isNewSessionDraftOpen,
  }), [draftDirectory, isNewSessionDraftOpen, sessionDirectory]);

  const gitBranchForDirectory = useGitBranchLabel(openDirectory || null);
  const currentBranchLabel = gitBranchForDirectory;
  const headerLocationLabel = React.useMemo(() => getHeaderLocationLabel({
    activeProjectLabel,
    openDirectory,
    homeDirectory,
  }), [activeProjectLabel, homeDirectory, openDirectory]);

  // Whether the title carries a second line under it. Hoisted because the
  // session menu's vertical alignment depends on the same answer.
  const showHeaderMetaRow = Boolean(headerLocationLabel || currentBranchLabel);


  const currentSessionTitle = React.useMemo(() => {
    if (!currentSessionId) {
      return headerLocationLabel ?? 'PiChamber';
    }
    const trimmedTitle = currentSession?.title?.trim();
    return trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : 'Untitled Session';
  }, [currentSession?.title, currentSessionId, headerLocationLabel]);
  const headerDirectoryStore = useDirectoryStore(openDirectory || undefined, { bootstrap: false });
  const sync = useSync();
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const [isRenamingHeaderSession, setIsRenamingHeaderSession] = React.useState(false);
  const [isHeaderSessionMenuOpen, setIsHeaderSessionMenuOpen] = React.useState(false);
  const pendingHeaderRenameRef = React.useRef(false);
  const [headerSessionTitleDraft, setHeaderSessionTitleDraft] = React.useState('');
  const [pendingHeaderRetentionAction, setPendingHeaderRetentionAction] = React.useState<'archive' | 'delete' | null>(null);
  const headerRenameFormRef = React.useRef<HTMLFormElement | null>(null);

  React.useEffect(() => {
    pendingHeaderRenameRef.current = false;
    setIsHeaderSessionMenuOpen(false);
    setIsRenamingHeaderSession(false);
    setHeaderSessionTitleDraft('');
    setPendingHeaderRetentionAction(null);
  }, [currentSessionId]);

  const beginHeaderSessionRename = React.useCallback(() => {
    if (!currentSessionId) return;
    setHeaderSessionTitleDraft(currentSession?.title?.trim() || currentSessionTitle);
    setIsRenamingHeaderSession(true);
  }, [currentSession?.title, currentSessionId, currentSessionTitle]);

  const saveHeaderSessionRename = React.useCallback(async () => {
    if (!currentSessionId) return;
    const title = headerSessionTitleDraft.trim();
    if (title && title !== currentSession?.title?.trim()) {
      await updateSessionTitle(currentSessionId, title);
    }
    setIsRenamingHeaderSession(false);
  }, [currentSession?.title, currentSessionId, headerSessionTitleDraft, updateSessionTitle]);

  React.useEffect(() => {
    if (!isRenamingHeaderSession) return;
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || !headerRenameFormRef.current?.contains(target)) {
        void saveHeaderSessionRename();
      }
    };
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [isRenamingHeaderSession, saveHeaderSessionRename]);

  const copyCurrentSessionId = React.useCallback(() => {
    if (!currentSessionId) return;
    void copyTextToClipboard(currentSessionId).then((result) => {
      toast[result.ok ? 'success' : 'error']((result.ok ? "Session ID copied" : "Failed to copy session ID"));
    }).catch(() => toast.error("Failed to copy session ID"));
  }, [currentSessionId]);
  const exportCurrentSession = React.useCallback(async () => {
    if (!currentSessionId || !openDirectory) {
      toast.error("Nothing to export");
      return;
    }
    try {
      await sync.syncSession(currentSessionId);
    } catch {
      toast.error("Failed to load the complete session history");
      return;
    }
    const records = buildSessionMessageRecordsSnapshot(headerDirectoryStore.getState(), currentSessionId).list;
    if (records.length === 0) {
      toast.error("Nothing to export");
      return;
    }
    const markdown = formatSessionAsMarkdown(records, currentSession?.title ?? null);
    const filename = buildExportFilename(currentSession?.title ?? null);
    const savedPath = await saveAsMarkdownDesktop(markdown, filename);
    if (!savedPath) downloadAsMarkdown(markdown, filename);
    toast.success("Session exported");
  }, [currentSession?.title, currentSessionId, headerDirectoryStore, openDirectory, sync]);

  const isCurrentSessionActive = currentSessionStatus?.type === 'busy' || currentSessionStatus?.type === 'retry';

  const confirmHeaderRetentionAction = React.useCallback(async () => {
    if (!currentSessionId || !pendingHeaderRetentionAction) return;
    const sessions = getAllSyncSessions();
    const ids = [currentSessionId];
    for (let index = 0; index < ids.length; index += 1) {
      const parentId = ids[index];
      for (const session of sessions) {
        if ((session as typeof session & { parentID?: string | null }).parentID === parentId && !ids.includes(session.id)) {
          ids.push(session.id);
        }
      }
    }
    const action = pendingHeaderRetentionAction;
    setPendingHeaderRetentionAction(null);
    const result = action === 'archive' ? await archiveSessions(ids) : await deleteSessions(ids);
    const failedIds = result.failedIds;
    if (failedIds.length > 0) {
      toast.error((action === 'archive' ? "Failed to archive session" : "Failed to delete session"));
      return;
    }
    toast.success((action === 'archive' ? "Session archived" : "Session deleted"));
  }, [archiveSessions, currentSessionId, deleteSessions, pendingHeaderRetentionAction]);

  // Full-page surfaces (Archive) replace the chat area;
  // while one is open the header shows the surface identity instead of the
  // session switcher.
  const isArchiveSurfaceOpen = useUIStore((state) => state.isArchivePageOpen);
  const activeSurfaceHeader = React.useMemo<{ title: string; subtitle: string | null } | null>(() => {
    if (isArchiveSurfaceOpen) {
      return { title: "Archive", subtitle: null };
    }
    return null;
  }, [isArchiveSurfaceOpen]);


  const actionDirectory = React.useMemo(() => {
    return normalize(openDirectory || activeProject?.path || '');
  }, [activeProject?.path, openDirectory]);

  const activeProjectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return { id: activeProject.id, path: activeProject.path };
  }, [activeProject]);

  const lastProjectActionsContextRef = React.useRef<{
    projectRef: { id: string; path: string };
    directory: string;
  } | null>(null);

  React.useEffect(() => {
    if (!activeProjectRef || !actionDirectory) {
      return;
    }
    lastProjectActionsContextRef.current = {
      projectRef: activeProjectRef,
      directory: actionDirectory,
    };
  }, [actionDirectory, activeProjectRef]);

  const projectActionsContext = React.useMemo(() => {
    if (activeProjectRef && actionDirectory) {
      return { projectRef: activeProjectRef, directory: actionDirectory };
    }
    return lastProjectActionsContextRef.current;
  }, [actionDirectory, activeProjectRef]);



  const handleGitHubAccountSwitch = React.useCallback(async (_accountId: string) => {}, []);

  const blurActiveElement = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    if (!active) {
      return;
    }

    const tagName = active.tagName;
    const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';

    if (isInput || active.isContentEditable) {
      active.blur();
    }
  }, []);

  const handleOpenSessionSwitcher = React.useCallback(() => {
    if (isMobile) {
      blurActiveElement();
      setSessionSwitcherOpen(!isSessionSwitcherOpen);
      return;
    }
    toggleSidebar();
  }, [blurActiveElement, isMobile, isSessionSwitcherOpen, setSessionSwitcherOpen, toggleSidebar]);

  const handleOpenDraftMiniChat = React.useCallback(() => {
    void invokeDesktop('desktop_open_draft_mini_chat_window', {
      directory: normalize(openDirectory || activeProject?.path || ''),
      projectId: activeProject?.id ?? null,
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[header] failed to open draft mini chat window', error);
    });
  }, [activeProject?.id, activeProject?.path, openDirectory]);

  const handleOpenCurrentMiniChat = React.useCallback(() => {
    if (isNewSessionDraftOpen) {
      handleOpenDraftMiniChat();
      return;
    }

    if (!currentSessionId) {
      return;
    }
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: currentSessionId,
      directory: normalize(openDirectory || activeProject?.path || ''),
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[header] failed to open session mini chat window', error);
    });
  }, [activeProject?.path, currentSessionId, handleOpenDraftMiniChat, isNewSessionDraftOpen, openDirectory]);

  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;
  const mobileHeaderIconButtonClass = MOBILE_HEADER_ICON_BUTTON_CLASS;
  const mobileActiveHeaderItem = React.useMemo(() => {
    if (leftDrawerOpen) {
      return 'sessions';
    }
    if (isTabletWorkspaceMode) {
      return rightDrawerOpen && tabletWorkspaceTab ? tabletWorkspaceTab : null;
    }
    if (rightDrawerOpen) {
      return 'git';
    }
    return activeMainTab;
  }, [activeMainTab, isTabletWorkspaceMode, leftDrawerOpen, rightDrawerOpen, tabletWorkspaceTab]);

  const closeMobileHeaderPanels = React.useCallback(() => {
    if (leftDrawerOpen && onToggleLeftDrawer) {
      onToggleLeftDrawer();
    }
    if (rightDrawerOpen && onToggleRightDrawer) {
      onToggleRightDrawer();
    }
    if (!onToggleLeftDrawer && isSessionSwitcherOpen) {
      setSessionSwitcherOpen(false);
    }
  }, [isSessionSwitcherOpen, leftDrawerOpen, onToggleLeftDrawer, onToggleRightDrawer, rightDrawerOpen, setSessionSwitcherOpen]);

  const handleMobileLeftDrawerToggle = React.useCallback(() => {
    onToggleLeftDrawer?.();
  }, [onToggleLeftDrawer]);

  const handleMobileRightDrawerToggle = React.useCallback(() => {
    onToggleRightDrawer?.();
  }, [onToggleRightDrawer]);

  // Left padding the header needs to clear the OS window controls (macOS
  // traffic lights / window-controls-overlay). When the sidebar is open this
  // space is owned by the sidebar's top strip instead, so the header drops back
  // to its normal content padding. The full value is published as
  // `--oc-titlebar-left-inset` so the sidebar strip can mirror it.
  const titlebarLeftInset = React.useMemo(() => {
    if (isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) {
      return '5.5rem';
    }
    if (isTabletStandalonePwa) {
      return 'max(calc(0.75rem + var(--oc-wco-left-inset, 0px)), 5.5rem)';
    }
    if ((!isDesktopApp || usesFramelessChrome)) {
      return 'calc(0.75rem + var(--oc-wco-left-inset, 0px))';
    }
    return '0.75rem';
  }, [isDesktopApp, isDesktopWindowFullscreen, isMacPlatform, isTabletStandalonePwa, usesFramelessChrome]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.style.setProperty('--oc-titlebar-left-inset', titlebarLeftInset);
  }, [titlebarLeftInset]);

  // Space reserved on the header's left for the persistent overlay when the
  // sidebar is collapsed (the overlay sits over the header then). Split into two
  // spacers so the strip stays a window drag area while the buttons stay
  // clickable: a drag region for the window-controls inset (traffic lights) and
  // a no-drag carve under the control cluster. Both animate so the session title
  // slides in/out in lockstep with the sidebar. When the sidebar is open the
  // overlay is over the sidebar, so the header only keeps normal content padding.
  const headerInsetSpacerWidth = isSidebarOpen ? '0.75rem' : 'var(--oc-titlebar-left-inset, 0.75rem)';
  // Tablet overlay renders the toggle at h-9 (see TABLET_TOGGLE_BUTTON_CLASS
  // in TitlebarLeftControls); phone/regular paths still use the 32px desktop
  // toggle so the +0.5rem right margin matches in either case.
  const headerControlsSpacerWidth = isSidebarOpen
    ? '0px'
    : isDesktopApp && usesFramelessChrome
      ? 'calc(var(--oc-titlebar-controls-width, 5.5rem) + 0.5rem)'
      : isTabletLayoutEnabled
        ? '2.75rem'
        : '2.5rem';

  useEffect(() => {
    if (!isDesktopApp || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;

    const syncFullscreenState = async () => {
      try {
        const fullscreen = await invokeDesktop<boolean>('desktop_is_window_fullscreen');
        if (!disposed) {
          setIsDesktopWindowFullscreen(fullscreen === true);
        }
      } catch {
        if (!disposed) {
          setIsDesktopWindowFullscreen(false);
        }
      }
    };

    const onResize = () => {
      void syncFullscreenState();
    };

    void syncFullscreenState();
    window.addEventListener('pichamber:window-resized', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('pichamber:window-resized', onResize);
    };
  }, [isDesktopApp, isMacPlatform]);

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-12';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const webWindowControlsOverlayStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (isDesktopApp && !usesFramelessChrome) {
      return undefined;
    }

    return {
      // Left inset is handled by the no-drag spacer (see renderDesktop); only
      // the right inset / titlebar height are owned by the window-controls overlay.
      paddingRight: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
      minHeight: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
      height: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
    };
  }, [isDesktopApp, usesFramelessChrome]);

  const updateHeaderHeight = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const height = headerRef.current?.getBoundingClientRect().height;
    if (height) {
      document.documentElement.style.setProperty('--oc-header-height', `${height}px`);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    updateHeaderHeight();

    const node = headerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return () => { };
    }

    let rafId = 0;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateHeaderHeight();
      });
    };

    const observer = new ResizeObserver(scheduleUpdate);

    observer.observe(node);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [updateHeaderHeight]);

  useEffect(() => {
    updateHeaderHeight();
  }, [updateHeaderHeight, isMobile, macosHeaderSizeClass]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  const tabs: TabConfig[] = React.useMemo(() => {
    if (isMobile) {
      const base: TabConfig[] = [
        { id: 'chat', label: "Chat", icon: "chat-4" },
        { id: 'diff', label: "Diff", icon: 'diff' },
        { id: 'files', label: "Files", icon: "file-text" },
        { id: 'terminal', label: "Terminal", icon: "terminal-box" },
        { id: 'context', label: "Context", icon: "file-list-2" },
        { id: 'diagram', label: "Diagram", icon: 'file' },
      ];

      return base;
    }

    // Desktop: no tabs in header
    return [];
  }, [isMobile]);

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  useEffect(() => {
    // Project actions may intentionally promote the terminal to the desktop
    // main view, and diagram clicks open the diagram viewer; every other
    // legacy main tab now lives in the context panel on desktop.
    if (!isMobile && activeMainTab !== 'chat' && activeMainTab !== 'terminal' && activeMainTab !== 'diagram') {
      setActiveMainTab('chat');
    }
  }, [activeMainTab, isMobile, setActiveMainTab]);

  // Desktop keeps instances only.
  const servicesTabs = React.useMemo(() => {
    const base: Array<{ value: 'instance'; label: string; icon: React.ReactNode }> = [];
    if (isDesktopApp) {
      base.push({ value: 'instance', label: "Instance", icon: <Icon name="server" className="h-3.5 w-3.5" /> });
    }
    return base;
  }, [isDesktopApp]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasModifier(e) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= tabs.length) {
          e.preventDefault();
          if (isMobile) {
            blurActiveElement();
            closeMobileHeaderPanels();
          }
          setActiveMainTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [blurActiveElement, closeMobileHeaderPanels, isMobile, setActiveMainTab, tabs]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const toggleServicesCombo = getEffectiveShortcutCombo('toggle_services_menu', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleServicesCombo)) {
        e.preventDefault();

        if (isDesktopServicesOpen) {
          setIsDesktopServicesOpen(false);
        } else {
          setIsDesktopServicesOpen(true);
          void refreshCurrentInstanceLabel();
        }
        return;
      }

      // The desktop menu holds one destination now, so this shortcut opens it
      // rather than cycling. The binding is kept: it is user-configurable and
      // silently dropping it would break existing setups.
      const cycleServicesCombo = getEffectiveShortcutCombo('cycle_services_tab', shortcutOverrides);
      if (eventMatchesShortcut(e, cycleServicesCombo)) {
        e.preventDefault();
        if (servicesTabs.length === 0) return;
        setIsDesktopServicesOpen(true);
        void refreshCurrentInstanceLabel();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    shortcutOverrides,
    isDesktopServicesOpen,
    servicesTabs,
    refreshCurrentInstanceLabel,
  ]);

  const renderTab = (tab: TabConfig) => {
    const isActive = activeMainTab === tab.id;
    const isDiffTab = tab.icon === 'diff';
    const tabIconName = isDiffTab ? null : (tab.icon as IconName);
    const isChatTab = tab.id === 'chat';

    const renderIcon = (iconSize: number) => {
      if (isDiffTab) {
        return <DiffIcon size={iconSize} />;
      }
      return tabIconName ? <Icon name={tabIconName} className={`h-${iconSize/4} w-${iconSize/4}`} /> : null;
    };

    const tabButton = (
      <button
        type="button"
        onClick={() => setActiveMainTab(tab.id)}
          className={cn(
            'relative flex h-8 items-center gap-2 px-3 rounded-lg typography-ui-label font-medium transition-colors',
            isActive
              ? 'app-region-no-drag bg-interactive-selection text-interactive-selection-foreground shadow-none'
              : 'app-region-no-drag text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isChatTab && !isMobile && 'min-w-[100px] justify-center'
          )}
        aria-label={tab.label}
        aria-selected={isActive}
        role="tab"
      >
        {isMobile ? (
          renderIcon(20)
        ) : (
          <>
            {renderIcon(16)}
            <span className="header-tab-label">{tab.label}</span>
          </>
        )}

        {tab.badge !== undefined && tab.badge > 0 && (
          <span className="header-tab-badge typography-micro text-status-info font-medium">
            {tab.badge}
          </span>
        )}
      </button>
    );

    return <React.Fragment key={tab.id}>{tabButton}</React.Fragment>;
  };

  const desktopSidebarActions = (
    <>
      <OpenInAppButton directory={actionDirectory} className="mr-1" />
      {/* Instances only exist in the desktop app. On web the menu was left
          holding a single dev-only shutdown action, which is not a reason to
          keep a dropdown in the header. */}
      {isDesktopApp ? (
      <DesktopServicesMenu
        isDesktopApp={isDesktopApp}
        currentInstanceLabel={currentInstanceLabel}
        compactCurrentInstanceLabel={compactCurrentInstanceLabel}
        currentInstanceIsLocal={currentInstanceIsLocal}
        isDesktopServicesOpen={isDesktopServicesOpen}
        setIsDesktopServicesOpen={setIsDesktopServicesOpen}
        refreshCurrentInstanceLabel={refreshCurrentInstanceLabel}
        shortcutLabel={shortcutLabel}
        remoteUpdateInfo={remoteUpdateInfo}
        remoteUpdateChecking={remoteUpdateChecking}
        remoteUpdateError={remoteUpdateError}
        onOpenRemoteUpdate={openRemoteInstanceUpdate}
      />
      ) : null}
      <DesktopGitHubControl
        isMobile={isMobile}
        githubAuthStatus={githubAuthStatus}
        githubAccounts={githubAccounts}
        githubAvatarUrl={githubAvatarUrl}
        githubLogin={githubLogin}
        isSwitchingGitHubAccount={isSwitchingGitHubAccount}
        handleGitHubAccountSwitch={handleGitHubAccountSwitch}
      />
    </>
  );

  const showMiniChatHeaderAction = hasElectronDesktopIPC && (isNewSessionDraftOpen || Boolean(currentSessionId));

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 select-none items-center pr-3',
        macosHeaderSizeClass
      )}
      style={webWindowControlsOverlayStyle}
      role="tablist"
      aria-label={"Main navigation"}
    >
      {/* Drag region for the window-controls inset (traffic lights) to the left
          of the overlay buttons — stays a window drag area. */}
      <div
        aria-hidden
        className="shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ width: headerInsetSpacerWidth }}
      />
      {/* No-drag carve under the persistent TitlebarLeftControls overlay so its
          buttons stay clickable. Width animates with the sidebar so the session
          title slides in lockstep instead of snapping. */}
      <div
        aria-hidden
        className="app-region-no-drag shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ width: headerControlsSpacerWidth }}
      />
      {/* Window chrome and the collapsed-sidebar toggle live in the persistent
          TitlebarLeftControls overlay; the spacers above reserve its footprint
          while the sidebar is closed. Project actions live in the header. */}
      <div className="flex min-w-0 flex-1 items-center">
        {activeSurfaceHeader ? (
          <div className="mr-3 flex min-w-0 flex-col items-start px-1 py-0.5 -my-0.5 text-left">
            <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
              {activeSurfaceHeader.title}
            </span>
            {activeSurfaceHeader.subtitle ? (
              <span className="truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75 max-w-full">
                {activeSurfaceHeader.subtitle}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="app-region-no-drag mr-3 flex min-w-0 max-w-full items-center gap-0.5 py-0.5 -my-0.5 text-left">
            {!isSidebarOpen ? (
              <React.Suspense
                fallback={
                  <button type="button" className={desktopHeaderIconButtonClass} aria-label="Open session switcher">
                    <Icon name="history" className="h-[18px] w-[18px]" />
                  </button>
                }
              >
                <SessionSwitcherDropdown align="start">
                  <button
                    type="button"
                    className={desktopHeaderIconButtonClass}
                    aria-label={"Open session switcher"}
                  >
                    <Icon name="history" className="h-[18px] w-[18px]" />
                  </button>
                </SessionSwitcherDropdown>
              </React.Suspense>
            ) : null}
            <div className="flex min-w-0 flex-col justify-center px-1">
              {isRenamingHeaderSession ? (
                <form
                  ref={headerRenameFormRef}
                  className="flex w-full min-w-0 items-center gap-2 leading-tight"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveHeaderSessionRename();
                  }}
                >
                  <input
                    value={headerSessionTitleDraft}
                    onChange={(event) => setHeaderSessionTitleDraft(event.target.value)}
                    autoFocus
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') {
                        setIsRenamingHeaderSession(false);
                      }
                    }}
                    placeholder={"Rename"}
                    className="min-w-0 flex-1 bg-transparent typography-ui-label font-normal leading-tight outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="submit"
                    aria-label={"Save session name"}
                    title={"Save session name"}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsRenamingHeaderSession(false)}
                    aria-label={"Cancel renaming session"}
                    title={"Cancel renaming session"}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </form>
              ) : (
                <span className="truncate typography-ui-label font-normal leading-tight text-foreground max-w-full">
                  {isNewSessionDraftOpen ? "New session" : currentSessionTitle}
                </span>
              )}
              {showHeaderMetaRow ? (
                <span className="flex min-w-0 max-w-full items-center gap-1.5 truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
                  {headerLocationLabel ? <span className="truncate">{headerLocationLabel}</span> : null}
                  {currentBranchLabel ? (
                    <span className="inline-flex min-w-0 items-center gap-0.5">
                      <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                      <span className="truncate">{currentBranchLabel}</span>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className={cn(
              'flex h-[18px] shrink-0 items-center justify-center',
              // Top-aligned only when the title has a metadata line under it;
              // alone, the title is centred and the button must follow.
              showHeaderMetaRow ? 'self-start' : 'self-center',
            )}>
              {currentSessionId && !isNewSessionDraftOpen && !isRenamingHeaderSession ? (
                <DropdownMenu
                  open={isHeaderSessionMenuOpen}
                  onOpenChange={setIsHeaderSessionMenuOpen}
                  onOpenChangeComplete={(open) => {
                    if (!open && pendingHeaderRenameRef.current) {
                      pendingHeaderRenameRef.current = false;
                      beginHeaderSessionRename();
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="xs" className="h-[18px] w-6 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" aria-label={"Open session actions"}>
                      <Icon name="more" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[190px]">
                    <DropdownMenuItem onClick={() => { pendingHeaderRenameRef.current = true; }}><Icon name="pencil-ai" className="mr-2 size-4" />{"Rename"}</DropdownMenuItem>
                    <DropdownMenuItem onClick={copyCurrentSessionId}><Icon name="file-copy" className="mr-2 size-4" />{"Copy session ID"}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void exportCurrentSession()}><Icon name="download" className="mr-2 size-4" />{"Export Markdown"}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setPendingHeaderRetentionAction('archive')}><Icon name="inbox-archive" className="mr-2 size-4" />{"Archive"}</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPendingHeaderRetentionAction('delete')}><Icon name="delete-bin" className="mr-2 size-4" />{"Delete"}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        )}

        {tabs.length > 0 && (
          <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-muted)]/50 p-1">
            {tabs.map((tab) => renderTab(tab))}
          </div>
        )}

        <div className="flex-1" />

        <div className="flex shrink-0 items-center gap-1">
          {projectActionsContext ? (
            <ProjectActionsButton
              projectRef={projectActionsContext.projectRef}
              directory={projectActionsContext.directory}
              className="mr-1"
            />
          ) : null}

          <HeaderIconActionButton
            visible={showMiniChatHeaderAction}
            title={isNewSessionDraftOpen ? "New Mini Chat Window" : "Open Session in Mini Chat"}
            ariaLabel={isNewSessionDraftOpen ? "Open a new Mini Chat window" : "Open current session in Mini Chat"}
            onClick={handleOpenCurrentMiniChat}
            className={cn(desktopHeaderIconButtonClass, 'mr-1')}
            Icon={'picture-in-picture-2'}
          />


          {desktopSidebarActions}
          <WindowsWindowControls visible={usesFramelessChrome && windowControlsSide === 'right'} position="right" />
        </div>
      </div>
    </div>
  );

  const renderMobile = () => (
    <div className="app-region-drag relative flex items-center gap-2 px-3 py-2 select-none">
      {isTabletLayoutEnabled && (
        <>
          <div
            aria-hidden
            className="shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{ width: headerInsetSpacerWidth }}
          />
          <div
            aria-hidden
            className="app-region-no-drag shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{ width: headerControlsSpacerWidth }}
          />
        </>
      )}
      {!isTabletLayoutEnabled && (
        <div className="flex items-center gap-2 shrink-0">
          {/* Use drawer toggle when onToggleLeftDrawer is provided, otherwise use legacy session switcher */}
          {onToggleLeftDrawer ? (
            <button
              type="button"
              onClick={handleMobileLeftDrawerToggle}
              className={cn(
                mobileHeaderIconButtonClass,
                mobileActiveHeaderItem === 'sessions' && 'bg-interactive-selection text-interactive-selection-foreground'
              )}
              aria-label={leftDrawerOpen ? "Close sessions" : "Open sessions"}
            >
              <Icon name="layout-left" className="h-5 w-5" />
            </button>
          ) : isSessionSwitcherOpen ? (
            <button
              type="button"
              onClick={() => setSessionSwitcherOpen(false)}
              className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
              aria-label={"Back"}
            >
              <Icon name="arrow-left-s" className="h-5 w-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleOpenSessionSwitcher}
              className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
              aria-label={"Open sessions"}
            >
              <Icon name="play-list-add" className="h-5 w-5" />
            </button>
          )}

          {!onToggleLeftDrawer && isSessionSwitcherOpen && (
            <span className="typography-ui-label font-semibold text-foreground">{"Sessions"}</span>
          )}
        </div>
      )}

      {(!isSessionSwitcherOpen || Boolean(onToggleLeftDrawer)) && (
        <>
          <div className="app-region-no-drag flex min-w-0 flex-1 items-center">
            {!isTabletWorkspaceMode && (
              <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-hidden touch-pan-x overscroll-x-contain" data-no-drawer-swipe="true">
                <div className="flex w-max items-center gap-1 pr-1">
                  <div
                    className="flex items-center gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 p-0.5"
                    role="tablist"
                    aria-label="Main navigation"
                  >
                    {tabs.map((tab) => {
                    const isActive = activeMainTab === tab.id;
                    const isDiffTab = tab.icon === 'diff';
                    const tabIconName = isDiffTab ? null : (tab.icon as IconName);
                    return (
                      <Tooltip key={tab.id}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => {
                              if (isMobile) {
                                blurActiveElement();
                                closeMobileHeaderPanels();
                              }
                              setActiveMainTab(tab.id);
                            }}
                            aria-label={tab.label}
                            aria-selected={isActive}
                            role="tab"
                            className={cn(
                              mobileHeaderIconButtonClass,
                              'relative rounded-lg',
                              mobileActiveHeaderItem === tab.id && 'bg-interactive-selection text-interactive-selection-foreground'
                            )}
                          >
                            {isDiffTab ? (
                              <DiffIcon className="h-5 w-5" />
                            ) : tabIconName ? (
                              <Icon name={tabIconName} className="h-5 w-5" />
                            ) : null}
                            {tab.badge !== undefined && tab.badge > 0 && (
                              <span className="absolute -top-1 -right-1 text-[10px] font-semibold text-primary">
                                {tab.badge}
                              </span>
                            )}
                            {tab.showDot && (
                              <span
                                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary"
                                aria-label={"Changes available"}
                              />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{tab.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isTabletWorkspaceMode && (
              <>
                <div
                  className="flex items-center gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 p-0.5"
                  role="tablist"
                  aria-label="Workspace"
                >
                  {tabletWorkspaceTabs.map((tab) => {
                    const isActive = rightDrawerOpen && tabletWorkspaceTab === tab.id;
                    return (
                      <Tooltip key={tab.id}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => {
                              if (isMobile) {
                                blurActiveElement();
                                closeMobileHeaderPanels();
                              }
                              setTabletMetadataOpen(false);
                              onSelectTabletWorkspaceTab?.(tab.id);
                            }}
                            aria-label={tab.label}
                            aria-selected={isActive}
                            role="tab"
                            className={cn(
                              mobileHeaderIconButtonClass,
                              'relative rounded-lg',
                              isActive && 'bg-interactive-selection text-interactive-selection-foreground'
                            )}
                          >
                            <Icon name={tab.icon} className="h-5 w-5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{tab.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
                <MobileSessionMetadataButton
                  open={tabletMetadataOpen}
                  onOpenChange={setTabletMetadataOpen}
                  currentSessionId={currentSessionId}
                  effectiveDirectory={openDirectory || null}
                  isNewSessionDraftOpen={isNewSessionDraftOpen}
                />
              </>
            )}
            {projectActionsContext && (
              <ProjectActionsButton
                projectRef={projectActionsContext.projectRef}
                directory={projectActionsContext.directory}
                compact
                allowMobile
                className="h-9"
              />
            )}

            {onToggleRightDrawer && !isTabletWorkspaceMode ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleMobileRightDrawerToggle}
                    className={cn(
                      mobileHeaderIconButtonClass,
                      'relative',
                      mobileActiveHeaderItem === 'git' && 'bg-interactive-selection text-interactive-selection-foreground'
                    )}
                    aria-label={rightDrawerOpen ? 'Close git sidebar' : 'Open git sidebar'}
                  >
                    <Icon name="layout-right" className="h-5 w-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{rightDrawerOpen ? 'Close git sidebar' : 'Open git sidebar'}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </>
      )}
    </div>
  );

  const headerClassName = cn(
    'header-safe-area relative z-10 bg-background',
    // Mobile keeps a full-width divider. On desktop the divider lives on the chat
    // content wrapper instead, so it doesn't run between the header and the right
    // sidebar (they read as one continuous surface).
    isMobile && 'border-b border-border/50'
  );

  return (
    <>
      <header
        ref={headerRef}
        className={headerClassName}
        style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
      >
        {isMobile ? renderMobile() : renderDesktop()}
      </header>
      <Dialog open={pendingHeaderRetentionAction !== null} onOpenChange={(open) => { if (!open) setPendingHeaderRetentionAction(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{pendingHeaderRetentionAction === 'delete'
              ? "Delete session?"
              : "Archive session?"}</DialogTitle>
            <DialogDescription>{pendingHeaderRetentionAction === 'delete'
              ? `\\"${currentSessionTitle}\\" will be permanently deleted.`
              : `\\"${currentSessionTitle}\\" will be archived.`}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingHeaderRetentionAction(null)}>
              {"Cancel"}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmHeaderRetentionAction()}>
              {pendingHeaderRetentionAction === 'delete'
                ? "Delete"
                : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UpdateDialog
        open={remoteUpdateDialogOpen}
        onOpenChange={setRemoteUpdateDialogOpen}
        info={remoteUpdateInfo}
        downloading={false}
        downloaded={false}
        progress={null}
        error={remoteUpdateError}
        onDownload={() => {}}
        onRestart={() => {}}
        runtimeType="web"
      />
    </>
  );
};
