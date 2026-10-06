import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { issueWorktreeBranchName } from './issueLogic';
import type { StartSessionTarget } from '../agent/useStartSessionFromGitHubItem';

/**
 * "Start session from issue" target picker.
 *
 * Current checkout opens the draft where the user already works; a new
 * worktree keeps the checkout untouched on branch `issue-<n>-<slug>`. The
 * draft composer is pre-filled (never sent) — the dialog only chooses where
 * the session will live.
 */
export const StartSessionDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issueNumber: number;
  issueTitle: string;
  busy: boolean;
  onChoose: (target: StartSessionTarget) => void;
}> = ({ open, onOpenChange, issueNumber, issueTitle, busy, onChoose }) => {
  const { t } = useTranslation();
  const [target, setTarget] = React.useState<StartSessionTarget>('worktree');
  const branch = issueWorktreeBranchName(issueNumber, issueTitle);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{t('Start session from issue #{{number}}', { number: issueNumber })}</DialogTitle>
          <DialogDescription>{t('Choose where the new session works. The composer is pre-filled — nothing is sent automatically.')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label={t("Session location")}>
          <button
            type="button"
            role="radio"
            aria-checked={target === 'current'}
            onClick={() => setTarget('current')}
            className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-left hover:bg-interactive-hover"
          >
            <Icon name={target === 'current' ? 'record-circle' : 'checkbox-blank-circle-fill'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block typography-ui-label text-foreground">{t('Current checkout')}</span>
              <span className="block typography-micro text-muted-foreground">{t('Work directly where you are now.')}</span>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={target === 'worktree'}
            onClick={() => setTarget('worktree')}
            className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-left hover:bg-interactive-hover"
          >
            <Icon name={target === 'worktree' ? 'record-circle' : 'checkbox-blank-circle-fill'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block typography-ui-label text-foreground">{t('New worktree')}</span>
              <span className="block truncate font-mono typography-micro text-muted-foreground" title={branch}>
                {t('Branch {{branch}}', { branch })}
              </span>
            </span>
          </button>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => onChoose(target)}
            disabled={busy}
            aria-label={target === 'worktree' ? t('Create worktree and open session draft') : t('Open session draft in current checkout')}
          >
            {busy ? t('Working…') : target === 'worktree' ? t('Create worktree') : t('Open draft')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
