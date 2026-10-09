import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { useCopyFeedback } from './useCopyFeedback';
import {
  SettingsControlGroup,
  SETTINGS_GROUP_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';
import type { TailscaleTone } from './tailscaleViewModel';

const PILL_TONE_CLASS: Record<TailscaleTone, string> = {
  neutral: 'text-muted-foreground bg-muted border-border/50',
  success: 'text-[var(--status-success)] bg-[var(--status-success)]/10 border-[var(--status-success)]/30',
  warning: 'text-[var(--status-warning)] bg-[var(--status-warning)]/10 border-[var(--status-warning)]/30',
  error: 'text-[var(--status-error)] bg-[var(--status-error-background)] border-[var(--status-error-border)]',
  info: 'text-[var(--status-info)] bg-[var(--status-info-background)] border-[var(--status-info-border)]',
};

/** Small status pill for route rows. Tones are status semantics only. */
export const RouteStatusPill: React.FC<{ tone: TailscaleTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span
    className={cn(
      'typography-micro shrink-0 rounded border px-1.5 py-px leading-relaxed',
      PILL_TONE_CLASS[tone],
    )}
  >
    {children}
  </span>
);

/** One "Ways to connect" route row: icon + title + pill, description, control. */
export const RouteRow: React.FC<{
  id?: string;
  icon: IconName;
  title: React.ReactNode;
  pill?: React.ReactNode;
  description: React.ReactNode;
  settingsItem?: string;
  children: React.ReactNode;
}> = ({ id, icon, title, pill, description, settingsItem, children }) => (
  <SettingsControlGroup
    settingsItem={settingsItem}
    title={(
      <span className="flex min-w-0 flex-wrap items-center gap-2" id={id}>
        <Icon name={icon} className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={SETTINGS_GROUP_TITLE_CLASS}>{title}</span>
        {pill}
      </span>
    )}
  >
    <div className="space-y-2">
      <p className="typography-meta text-muted-foreground">{description}</p>
      {children}
    </div>
  </SettingsControlGroup>
);

/** Address line with copy button (and optional Open action). */
export const RouteAddress: React.FC<{
  url: string;
  copyLabel: string;
  action?: React.ReactNode;
}> = ({ url, copyLabel, action }) => {
  const { copied, copy } = useCopyFeedback();
  return (
    <div className="flex min-w-0 max-w-[24rem] items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate font-mono typography-micro text-foreground">{url}</code>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="!font-normal shrink-0"
        onClick={() => copy(url)}
        aria-label={copied ? `${copyLabel} (copied)` : copyLabel}
      >
        <Icon
          name={copied ? 'check' : 'file-copy'}
          className={cn('h-3.5 w-3.5', copied && 'text-[var(--status-success)]')}
          aria-hidden
        />
      </Button>
      {action}
    </div>
  );
};
