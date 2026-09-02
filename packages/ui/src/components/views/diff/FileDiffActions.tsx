import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { FileDiffAction } from './diffTypes';

export interface FileDiffActionButtonProps {
  label: string;
  icon: 'add' | 'arrow-go-back';
  loading: boolean;
  disabled: boolean;
  tone?: 'failure' | 'success';
  onClick: () => void;
}

export const FileDiffActionButton: React.FC<FileDiffActionButtonProps> = ({
  label,
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
      'h-6 w-6 rounded-none bg-transparent p-0 text-muted-foreground opacity-70 hover:bg-transparent hover:text-foreground hover:opacity-100',
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
      <Icon name={icon} className={icon === 'add' ? 'size-4' : 'size-3.5'} />
    )}
  </Button>
);

export interface FileDiffActionsProps {
  filePath: string;
  staged: boolean;
  busyAction: FileDiffAction | null;
  disabled: boolean;
  onAction: (action: FileDiffAction) => void;
}

export const FileDiffActions = React.memo<FileDiffActionsProps>(function FileDiffActions({
  filePath,
  staged,
  busyAction,
  disabled,
  onAction,
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-[var(--interactive-border)]/45 bg-[var(--surface-background)]/95 px-1 py-0.5 shadow-sm backdrop-blur-md">
      {staged ? (
        <FileDiffActionButton
          label={`Unstage ${filePath}`}
          icon="arrow-go-back"
          loading={busyAction === 'unstage'}
          disabled={disabled}
          onClick={() => onAction('unstage')}
        />
      ) : (
        <>
          <FileDiffActionButton
            label={`Revert changes in ${filePath}`}
            icon="arrow-go-back"
            loading={busyAction === 'discard'}
            disabled={disabled}
            tone="failure"
            onClick={() => onAction('discard')}
          />
          <FileDiffActionButton
            label={`Stage ${filePath}`}
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
