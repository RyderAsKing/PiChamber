import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import type { GitMergeInProgress, GitRebaseInProgress } from '@/lib/api/types';

interface InProgressOperationBannerProps {
  mergeInProgress: GitMergeInProgress | null | undefined;
  rebaseInProgress: GitRebaseInProgress | null | undefined;
  onContinue: () => Promise<void>;
  onAbort: () => Promise<void>;
  onResolveWithAI?: () => void;
  conflictCount?: number;
  isLoading?: boolean;
}

export const InProgressOperationBanner: React.FC<InProgressOperationBannerProps> = ({
  mergeInProgress,
  rebaseInProgress,
  onContinue,
  onAbort,
  onResolveWithAI,
  conflictCount = 0,
  isLoading = false,
}) => {
  const { t } = useTranslation();

  const [processingAction, setProcessingAction] = React.useState<'continue' | 'abort' | null>(null);

  // Only show banner if we have actual in-progress operation data
  const hasMergeInProgress = mergeInProgress && mergeInProgress.head;
  const hasRebaseInProgress = rebaseInProgress && (rebaseInProgress.headName || rebaseInProgress.onto);
  const operation = hasMergeInProgress ? 'merge' : hasRebaseInProgress ? 'rebase' : null;

  if (!operation) {
    return null;
  }

  const handleContinue = async () => {
    setProcessingAction('continue');
    try {
      await onContinue();
    } finally {
      setProcessingAction(null);
    }
  };

  const handleAbort = async () => {
    setProcessingAction('abort');
    try {
      await onAbort();
    } finally {
      setProcessingAction(null);
    }
  };

  const isProcessing = processingAction !== null;
  const hasUnresolvedConflicts = conflictCount > 0;

  const operationLabel = operation === 'merge' ? t("Merge") : t("Rebase");

  // Build description
  let description = '';
  if (mergeInProgress) {
    description = mergeInProgress.message
      ? t('Merging: {{message}}', { message: mergeInProgress.message })
      : t('Merging {{head}}', { head: mergeInProgress.head });
  } else if (rebaseInProgress) {
    description = rebaseInProgress.headName
      ? t('Rebasing {{head}} onto {{onto}}', { head: rebaseInProgress.headName, onto: rebaseInProgress.onto || '' })
      : t("Rebase in progress");
  }

  const title = !hasUnresolvedConflicts
    ? t('{{operation}} in progress', { operation: operationLabel })
    : conflictCount === 1
      ? t('{{operation}} in progress: {{count}} conflict', { operation: operationLabel, count: conflictCount })
      : t('{{operation}} in progress: {{count}} conflicts', { operation: operationLabel, count: conflictCount });

  const hint = hasUnresolvedConflicts
    ? t("Resolve conflicts, then continue the operation.")
    : t("All conflicts resolved. Continue to finish the operation.");

  return (
    <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-[var(--status-warning-border)]">
      <div className="flex flex-col gap-3 p-3">
        <div className="min-w-0">
          <p className="typography-label text-[var(--status-warning)]">
            {title}
          </p>
          {description && (
            <p className="typography-micro break-words text-muted-foreground">
              {description}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="typography-micro min-w-0 flex-1 text-muted-foreground">
            {hint}
          </p>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAbort}
              disabled={isProcessing || isLoading}
              className="gap-1.5"
            >
              {processingAction === 'abort' ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <Icon name="close" className="size-4" />
              )}
              {t("Abort")}
            </Button>

            {hasUnresolvedConflicts
              ? onResolveWithAI && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={onResolveWithAI}
                  disabled={isProcessing || isLoading}
                >
                  {t("Resolve with AI")}
                </Button>
              )
              : (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleContinue}
                  disabled={isProcessing || isLoading}
                  className="gap-1.5"
                >
                  {processingAction === 'continue' ? (
                    <Icon name="loader-4" className="size-4 animate-spin" />
                  ) : (
                    <Icon name="check" className="size-4" />
                  )}
                  {t("Continue")}
                </Button>
              )}
          </div>
        </div>
      </div>
    </div>
  );
};
