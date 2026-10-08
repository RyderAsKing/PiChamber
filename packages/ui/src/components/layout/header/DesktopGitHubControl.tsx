import React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '@/components/icon/Icon';
import { useGitHubLogin, useGitHubStatusStore } from '@/stores/useGitHubStatusStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { cn } from '@/lib/utils';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS } from './HeaderIconActionButton';

/**
 * Read-only GitHub account indicator (plan §6.6).
 *
 * Shows avatar + `@login` + "via GitHub CLI" for the server's active gh
 * account. No switching, no disconnect. Hidden when gh is missing or
 * unauthenticated — Settings covers those states.
 */
export const DesktopGitHubControl: React.FC<{ isMobile?: boolean }> = ({ isMobile }) => {
  const { t } = useTranslation();
  const apis = useRuntimeAPIs();
  const github = apis.github ?? null;
  const refresh = useGitHubStatusStore((state) => state.refresh);
  const login = useGitHubLogin();

  React.useEffect(() => {
    if (!github || isMobile) return;
    void refresh(github);
  }, [github, isMobile, refresh]);

  if (isMobile || !github) return null;

  // Read-only acting account; hidden when unauthenticated (Settings covers it).
  if (!login) return null;

  // Status carries login/scopes but no avatar URL — the github glyph is the
  // visual anchor alongside @login.
  return (
    <span
      className={cn(DESKTOP_HEADER_ICON_BUTTON_CLASS, 'app-region-no-drag inline-flex w-auto cursor-default gap-1.5 px-2')}
      title={t('{{login}} via GitHub CLI', { login })}
      aria-label={t('Signed in to GitHub as {{login}} via GitHub CLI', { login })}
    >
      <Icon name="github-fill" className="h-3.5 w-3.5 shrink-0 text-foreground" />
      <span className="max-w-28 truncate typography-micro text-muted-foreground">@{login}</span>
    </span>
  );
};
