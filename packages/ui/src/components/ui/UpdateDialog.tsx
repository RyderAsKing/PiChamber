import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from "@/components/icon/Icon";
import type { UpdateInfo, UpdateProgress } from '@/lib/desktop';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { getRuntimeEndpointGeneration } from '@/lib/runtime-switch';
import {
  installWebUpdate,
  waitForUpdateApplied,
  waitForUpdateJob,
  type WebUpdateState,
} from './web-update';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: UpdateInfo | null;
  downloading: boolean;
  downloaded: boolean;
  progress: UpdateProgress | null;
  error: string | null;
  onDownload: () => void;
  onRestart: () => void;
  /** Runtime type to show different UI for desktop vs web */
  runtimeType?: 'desktop' | 'web' | 'mobile' | null;
}

const GITHUB_RELEASES_URL = 'https://github.com/RyderAsKing/PiChamber/releases';

type ChangelogSection = {
  version: string;
  date: string;
  start: number;
  end: number;
  raw: string;
};

type ParsedChangelog =
  | {
      kind: 'raw';
      title: string;
      content: string;
    }
  | {
      kind: 'sections';
      title: string;
      sections: Array<{ version: string; dateLabel: string; content: string }>;
    };

function formatIsoDateForUI(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    return isoDate;
  }
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

function stripChangelogHeading(sectionRaw: string): string {
  return sectionRaw.replace(/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\s*\n?/, '').trim();
}

function processChangelogMentions(content: string): string {
  // Convert @username to markdown links so they can be styled via css
  return content.replace(/(^|[^a-zA-Z0-9])@([a-zA-Z0-9-]+)/g, '$1[@$2](https://github.com/$2)');
}

function compareSemverDesc(a: string, b: string): number {
  const splitVersion = (version: string): [string, string] => {
    const dash = version.indexOf('-');
    return dash < 0 ? [version, ''] : [version.slice(0, dash), version.slice(dash + 1)];
  };
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const pa = coreA.split('.').map((v) => Number.parseInt(v, 10));
  const pb = coreB.split('.').map((v) => Number.parseInt(v, 10));
  for (let i = 0; i < 3; i += 1) {
    const da = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const db = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (da !== db) {
      return db - da;
    }
  }
  // Same core version: the release sorts above its prereleases (1.0.4 > 1.0.4-rc.2),
  // and prereleases compare with numeric segments (rc.10 > rc.2).
  if (!preA || !preB) {
    return (preA ? 1 : 0) - (preB ? 1 : 0);
  }
  return preB.localeCompare(preA, undefined, { numeric: true });
}

function parseChangelogSections(body: string): ChangelogSection[] {
  const re = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\] - (\d{4}-\d{2}-\d{2})\s*$/gm;
  const matches: Array<{ version: string; date: string; start: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    matches.push({
      version: m[1] ?? '',
      date: m[2] ?? '',
      start: m.index,
    });
  }

  if (matches.length === 0) {
    return [];
  }

  return matches.map((match, idx) => {
    const end = matches[idx + 1]?.start ?? body.length;
    const raw = body.slice(match.start, end).trim();
    return { version: match.version, date: match.date, start: match.start, end, raw };
  });
}

export const UpdateDialog: React.FC<UpdateDialogProps> = ({
  open,
  onOpenChange,
  info,
  downloading,
  downloaded,
  progress,
  error,
  onDownload,
  onRestart,
  runtimeType = 'desktop',
}) => {
  const { t } = useTranslation();
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [webUpdateState, setWebUpdateState] = useState<WebUpdateState>('idle');
  const [webError, setWebError] = useState<string | null>(null);
  const [webCommands, setWebCommands] = useState<string[] | null>(null);
  const [webTarget, setWebTarget] = useState<{ version?: string; channel?: 'stable' | 'rc' }>({});

  const releaseUrl = info?.version
    ? (info.releaseUrl || `${GITHUB_RELEASES_URL}/tag/v${info.version}`)
    : GITHUB_RELEASES_URL;
  const mobileUpdateUrl = info?.downloadUrl || releaseUrl;

  const progressPercent = progress?.total
    ? Math.round((progress.downloaded / progress.total) * 100)
    : 0;

  const isWebRuntime = runtimeType === 'web';
  const isMobileRuntime = runtimeType === 'mobile';
  const updateCommand = info?.updateCommand || 'pichamber update';
  const displayedVersion = webTarget.version || info?.version;
  const displayedChannel = webTarget.channel || info?.channel;

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setWebUpdateState('idle');
      setWebError(null);
      setWebCommands(null);
      setWebTarget({});
    }
  }, [open]);

  const handleCopyCommand = async (command = updateCommand) => {
    const result = await copyTextToClipboard(command);
    if (result.ok) {
      setCopiedCommand(command);
      setTimeout(() => setCopiedCommand(null), 2000);
    }
  };

  const handleOpenExternal = useCallback(async (url: string) => {
    await openExternalUrl(url);
  }, []);
  const handleWebUpdate = useCallback(async () => {
    const runtimeGeneration = getRuntimeEndpointGeneration();
    setWebUpdateState('updating');
    setWebError(null);
    setWebCommands(null);
    setWebTarget({});

    const result = await installWebUpdate();
    if (getRuntimeEndpointGeneration() !== runtimeGeneration) return;

    if (!result.success) {
      setWebUpdateState('error');
      setWebError(result.error || t("Update failed"));
      setWebCommands(result.commands ?? null);
      return;
    }

    setWebTarget({ version: result.targetVersion, channel: result.channel });

    if (result.jobId) {
      const outcome = await waitForUpdateJob(
        result.jobId,
        (state) => {
          if (getRuntimeEndpointGeneration() === runtimeGeneration) setWebUpdateState(state);
        },
        undefined,
        undefined,
        runtimeGeneration,
      );
      if (outcome.stale || getRuntimeEndpointGeneration() !== runtimeGeneration) return;
      if (outcome.applied) {
        window.location.reload();
        return;
      }
      setWebUpdateState('error');
      setWebError(outcome.error || t("Update is taking longer than expected. Wait a bit and refresh, or run: pichamber update"));
      return;
    }

    // Older servers do not return a job ID. Keep the version-based reconnect
    // path so a newer mobile or desktop client can still update them.
    setWebUpdateState(result.autoRestart ? 'restarting' : 'reconnecting');
    const outcome = await waitForUpdateApplied(info?.currentVersion, undefined, undefined, runtimeGeneration);
    if (outcome.stale || getRuntimeEndpointGeneration() !== runtimeGeneration) return;
    if (outcome.applied) {
      window.location.reload();
      return;
    }
    setWebUpdateState('error');
    setWebError(outcome.error || t("Update is taking longer than expected. Wait a bit and refresh, or run: pichamber update"));
  }, [info?.currentVersion, t]);

  const handleMobileUpdate = useCallback(() => {
    void handleOpenExternal(mobileUpdateUrl);
  }, [handleOpenExternal, mobileUpdateUrl]);

  const isWebUpdating = webUpdateState !== 'idle' && webUpdateState !== 'error';

  const changelog = useMemo<ParsedChangelog | null>(() => {
    if (!info?.body) {
      return null;
    }

    const body = info.body.trim();
    if (!body) {
      return null;
    }

    const sections = parseChangelogSections(body);

    if (sections.length === 0) {
      return {
        kind: 'raw',
        title: t("What's new"),
        content: processChangelogMentions(body),
      };
    }

    const sorted = [...sections].sort((a, b) => compareSemverDesc(a.version, b.version));
    return {
      kind: 'sections',
      title: t("What's new"),
      sections: sorted.map((section) => ({
        version: section.version,
        dateLabel: formatIsoDateForUI(section.date),
        content: processChangelogMentions(stripChangelogHeading(section.raw) || body),
      })),
    };
  }, [info?.body, t]);

  return (
    <Dialog open={open} onOpenChange={isWebUpdating ? undefined : onOpenChange}>
      <DialogContent className="max-w-4xl p-4 sm:p-5 bg-background border-[var(--interactive-border)]" showCloseButton={true}>
        
        {/* Header Section: the title keeps its own line and the version meta
            wraps beneath it on narrow (phone) dialogs instead of squeezing
            every piece into one row. Each piece stays unbroken. */}
        <div className="mb-1 space-y-1 pr-8">
          <DialogTitle className="flex items-center gap-2.5">
            <Icon name="download-cloud" className="h-5 w-5 shrink-0 text-[var(--primary-base)]" />
            <span className="text-lg font-semibold text-foreground">
              {webUpdateState === 'restarting' || webUpdateState === 'reconnecting'
                ? t("Updating PiChamber...")
                : t("Update available")}
            </span>
          </DialogTitle>

          {(info?.currentVersion || displayedVersion || (isWebRuntime && displayedChannel)) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[1.875rem]">
              {(info?.currentVersion || displayedVersion) && (
                <div className="flex items-center gap-2 whitespace-nowrap font-mono text-sm">
                  {info?.currentVersion && (
                    <span className="text-muted-foreground">{info.currentVersion}</span>
                  )}
                  {info?.currentVersion && displayedVersion && (
                    <span className="text-muted-foreground/50" aria-hidden="true">→</span>
                  )}
                  {displayedVersion && (
                    <span className="text-[var(--primary-base)] font-medium">{displayedVersion}</span>
                  )}
                </div>
              )}
              {isWebRuntime && displayedChannel && (
                <span className="whitespace-nowrap typography-meta text-muted-foreground">
                  {displayedChannel === 'rc' ? t("RC channel") : t("Stable channel")}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Content Body */}
        <div className="space-y-2">

          {/* Web update progress */}
          {isWebRuntime && isWebUpdating && (
            <div className="rounded-lg bg-[var(--surface-elevated)]/30 p-5 border border-[var(--surface-subtle)]">
              <div className="flex items-center gap-3">
                <Icon name="loader" className="h-5 w-5 animate-spin text-[var(--primary-base)]" />
                <div className="typography-ui-label text-foreground">
                  {webUpdateState === 'updating' && t("Installing update...")}
                  {webUpdateState === 'restarting' && t("Server restarting...")}
                  {webUpdateState === 'reconnecting' && t("Waiting for server...")}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("The page will reload automatically when the update is complete.")}
              </p>
            </div>
          )}

          {/* Changelog Rendering */}
          {changelog && !isWebUpdating && (
            <div className="rounded-lg border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/20 overflow-hidden">
              <ScrollableOverlay
                className="max-h-[min(400px,50dvh)] p-0"
                fillContainer={false}
              >
                {changelog.kind === 'raw' ? (
                  <div
                    className="p-4 typography-markdown-body text-foreground leading-relaxed break-words [&_a]:!text-[var(--primary-base)] [&_a]:!no-underline [&_a:hover]:!underline"
                    onClickCapture={(e) => {
                      const target = e.target as HTMLElement;
                      const a = target.closest('a');
                      if (a && a.href) {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleOpenExternal(a.href);
                      }
                    }}
                  >
                    <SimpleMarkdownRenderer content={changelog.content} disableLinkSafety={true} enableFileReferences={false} />
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--surface-subtle)]">
                    {changelog.sections.map((section) => (
                      <div key={section.version} className="p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="typography-ui-label font-mono text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-1.5 py-0.5 rounded">
                            v{section.version}
                          </span>
                          <span className="text-sm font-medium text-muted-foreground">
                            {section.dateLabel}
                          </span>
                        </div>
                        <div
                          className="typography-markdown-body text-foreground leading-relaxed break-words [&_a]:!text-[var(--primary-base)] [&_a]:!no-underline [&_a:hover]:!underline"
                          onClickCapture={(e) => {
                            const target = e.target as HTMLElement;
                            const a = target.closest('a');
                            if (a && a.href) {
                              e.preventDefault();
                              e.stopPropagation();
                              void handleOpenExternal(a.href);
                            }
                          }}
                        >
                          <SimpleMarkdownRenderer content={section.content} disableLinkSafety={true} enableFileReferences={false} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollableOverlay>
            </div>
          )}

          {/* Error display */}
          {(error || webError) && (
            <div className="p-3 mt-4 bg-[var(--status-error-background)] border border-[var(--status-error-border)] rounded-lg">
              <p className="text-sm text-[var(--status-error)]">{error || webError}</p>
            </div>
          )}

          {/* Web runtime fallback command */}
          {isWebRuntime && webUpdateState === 'error' && (webCommands ?? [updateCommand]).length > 0 && (
            <div className="space-y-2 mt-4">
              <div className="flex items-center gap-2 typography-meta text-muted-foreground">
                <Icon name="terminal" className="h-4 w-4" />
                <span>{webCommands ? t("Run these commands:") : t("Or update via terminal:")}</span>
              </div>
              {(webCommands ?? [updateCommand]).map((command) => (
                <div key={command} className="flex items-center gap-2 p-1 pl-3 bg-[var(--surface-elevated)]/50 rounded-md border border-[var(--surface-subtle)]">
                  <code className="flex-1 font-mono text-sm text-foreground overflow-x-auto whitespace-nowrap">
                    {command}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void handleCopyCommand(command)}
                    className={copiedCommand === command ? 'text-[var(--status-success)]' : undefined}
                    title={copiedCommand === command ? t("Copied!") : t("Copy command")}
                    aria-label={copiedCommand === command ? t("Copied!") : t("Copy command")}
                  >
                    {copiedCommand === command ? (
                      <Icon name="check" className="h-4 w-4" />
                    ) : (
                      <Icon name="clipboard" className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Desktop progress bar */}
          {!isWebRuntime && !isMobileRuntime && downloading && (
            <div className="space-y-2 mt-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("Downloading update payload...")}</span>
                <span className="font-mono text-foreground">{progressPercent}%</span>
              </div>
              <div className="h-1.5 bg-[var(--surface-subtle)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--primary-base)] transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

        </div>

        {/* Action Footer */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <Icon name="external-link" className="h-4 w-4" />
            GitHub
          </a>

          <div className="flex-1 flex justify-end">
            {/* Desktop Buttons */}
            {!isWebRuntime && !isMobileRuntime && !downloaded && !downloading && (
              <Button onClick={onDownload}>
                <Icon name="download" className="h-4 w-4" />
                {t("Download update")}
              </Button>
            )}

            {!isWebRuntime && !isMobileRuntime && downloading && (
              <Button disabled>
                <Icon name="loader" className="h-4 w-4 animate-spin" />
                {t("Downloading...")}
              </Button>
            )}

            {!isWebRuntime && !isMobileRuntime && downloaded && (
              <button
                onClick={onRestart}
                className="flex items-center justify-center gap-2 px-5 py-2 rounded-md text-sm font-medium bg-[var(--status-success)] text-white hover:opacity-90 transition-opacity"
              >
                <Icon name="restart" className="h-4 w-4" />
                {t("Restart to Update")}
              </button>
            )}

            {/* Web Buttons */}
            {isMobileRuntime && (
              <Button
                onClick={handleMobileUpdate}
                size="default"
              >
                <Icon name="external-link" className="h-4 w-4" />
                {t("Open update")}
              </Button>
            )}

            {isWebRuntime && !isWebUpdating && (
              <Button onClick={handleWebUpdate}>
                <Icon name="download" className="h-4 w-4" />
                {t("Update now")}
              </Button>
            )}

            {isWebRuntime && isWebUpdating && (
              <Button disabled>
                <Icon name="loader" className="h-4 w-4 animate-spin" />
                {t("Updating...")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
