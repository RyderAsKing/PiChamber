import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { FileDiffAction } from './diffTypes';

export interface FileDiffActionButtonProps {
  /** Full name of the action, for assistive tech and the tooltip. */
  label: string;
  /** The word shown on the button, so the action reads without hovering. */
  text: string;
  icon: 'add' | 'arrow-go-back';
  loading: boolean;
  disabled: boolean;
  tone?: 'failure' | 'success';
  onClick: () => void;
}

export const FileDiffActionButton: React.FC<FileDiffActionButtonProps> = ({
  label,
  text,
  icon,
  loading,
  disabled,
  tone,
  onClick,
}) => (
  <Button
    variant="ghost"
    size="sm"
    className={cn(
      'h-6 gap-1 rounded-md bg-transparent px-2 typography-micro font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
      tone === 'failure' && 'text-[var(--status-error)] hover:text-[var(--status-error)]',
      tone === 'success' && 'text-[var(--status-success)] hover:text-[var(--status-success)]'
    )}
    disabled={disabled}
    title={label}
    aria-label={label}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
  >
    {loading ? (
      <Icon name="loader-4" className="size-3.5 animate-spin" />
    ) : (
      <Icon name={icon} className="size-3.5" />
    )}
    {text}
  </Button>
);

export interface FileDiffActionsProps {
  filePath: string;
  staged: boolean;
  /** Part of the file is already staged, so its actions reach only the rest. */
  partlyStaged?: boolean;
  busyAction: FileDiffAction | null;
  disabled: boolean;
  onAction: (action: FileDiffAction) => void;
}

export const FileDiffActions = React.memo<FileDiffActionsProps>(function FileDiffActions({
  filePath,
  staged,
  partlyStaged = false,
  busyAction,
  disabled,
  onAction,
}) {
  return (
    <div className="flex items-center gap-1">
      {staged ? (
        <FileDiffActionButton
          label={`Unstage ${filePath}`}
          text={'Unstage'}
          icon="arrow-go-back"
          loading={busyAction === 'unstage'}
          disabled={disabled}
          onClick={() => onAction('unstage')}
        />
      ) : (
        <>
          <FileDiffActionButton
            label={partlyStaged ? `Revert unstaged changes in ${filePath}` : `Revert changes in ${filePath}`}
            text={partlyStaged ? 'Revert unstaged' : 'Revert'}
            icon="arrow-go-back"
            loading={busyAction === 'discard'}
            disabled={disabled}
            tone="failure"
            onClick={() => onAction('discard')}
          />
          <FileDiffActionButton
            label={partlyStaged ? `Stage the rest of ${filePath}` : `Stage ${filePath}`}
            text={partlyStaged ? 'Stage the rest' : 'Stage'}
            icon="add"
            loading={busyAction === 'stage'}
            disabled={disabled}
            tone="success"
            onClick={() => onAction('stage')}
          />
        </>
      )}
    </div>
  );
});
