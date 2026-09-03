import { Button } from '@/components/ui/button';
import { CommitInput } from './CommitInput';
import { useDeviceInfo } from '@/lib/device';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";

type CommitAction = 'commit' | 'commitAndPush' | null;

interface CommitSectionProps {
  stagedCount: number;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  onCommitAndPush: () => void;
  commitAction: CommitAction;
  hasPendingIndexMutation?: boolean;
  gitmojiEnabled: boolean;
  onOpenGitmojiPicker: () => void;
}

export const CommitSection: React.FC<CommitSectionProps> = ({
  stagedCount,
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onCommitAndPush,
  commitAction,
  hasPendingIndexMutation = false,
  gitmojiEnabled,
  onOpenGitmojiPicker,
}) => {
  
  const hasStagedFiles = stagedCount > 0;
  const canCommit = commitMessage.trim() && hasStagedFiles && commitAction === null && !hasPendingIndexMutation;
  const { isMobile, hasTouchInput } = useDeviceInfo();

  const containerClassName = 'border-0 bg-transparent rounded-none';
  const headerClassName = 'flex w-full items-baseline gap-2 px-0 pt-2 pb-1';
  const contentClassName = 'flex flex-col gap-3 px-0 pt-1 pb-3';

  return (
    <section className={containerClassName}>
      <div className={headerClassName}>
        <h3 className="typography-ui-header font-semibold text-foreground">{"Commit"}</h3>
        {!hasStagedFiles ? (
          <span className="min-w-0 truncate typography-meta text-muted-foreground">
            {"Stage files to enable commit."}
          </span>
        ) : null}
      </div>

      <div className={contentClassName}>
        <CommitInput
          value={commitMessage}
          onChange={onCommitMessageChange}
          placeholder={"Commit message"}
          disabled={commitAction !== null}
          hasTouchInput={hasTouchInput}
          isMobile={isMobile}
        />

        {gitmojiEnabled && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenGitmojiPicker}
            className="w-fit"
            type="button"
          >
            <Icon name="emotion-happy" className="size-4" />
            {"Add gitmoji"}
          </Button>
        )}

        <div className="@container/commit-actions flex items-center gap-2 min-w-0">
          <div className="flex-1" />

          <Button
            size="sm"
            variant="outline"
            onClick={onCommit}
            disabled={!canCommit}
            className="commit-actions__btn whitespace-nowrap"
            aria-label={"Commit  aria label"}
          >
            {commitAction === 'commit' ? (
              <>
                <Icon name="loader-4" className="size-4 animate-spin" />
                <span className="commit-actions__label">{"Committing..."}</span>
              </>
            ) : (
              <>
                <Icon name="git-commit" className="size-4" />
                <span className="commit-actions__label">{"Commit"}</span>
              </>
            )}
          </Button>

          {isMobile ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => onCommitAndPush()}
                  disabled={!canCommit}
                  className="h-7 w-7 p-0"
                  aria-label={"Commit and sync"}
                >
                  {commitAction === 'commitAndPush' ? (
                    <Icon name="loader-4" className="size-4 animate-spin" />
                  ) : (
                    <Icon name="arrow-up" className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{"Commit & sync"}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              size="sm"
              variant="default"
              onClick={() => onCommitAndPush()}
              disabled={!canCommit}
              className="commit-actions__btn"
              aria-label={"Commit and sync"}
            >
              {commitAction === 'commitAndPush' ? (
                <>
                  <Icon name="loader-4" className="size-4 animate-spin" />
                  <span className="commit-actions__label commit-actions__label--push">{"Syncing..."}</span>
                </>
              ) : (
                <>
                  <Icon name="arrow-up" className="size-3.5" />
                  <span className="commit-actions__label commit-actions__label--push">{"Commit & sync"}</span>
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
};
