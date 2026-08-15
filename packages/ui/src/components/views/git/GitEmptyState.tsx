import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";

interface GitEmptyStateProps {
  onOpenStashes?: () => void;
}

export const GitEmptyState: React.FC<GitEmptyStateProps> = ({ onOpenStashes }) => {
  
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
      <Icon name="git-commit" className="size-10 text-muted-foreground/70 mb-4" />
      <p className="typography-ui-label font-semibold text-foreground mb-1">
        {"Working tree clean"}
      </p>
      <p className="typography-meta text-muted-foreground mb-4">
        {"All changes have been committed"}
      </p>

      {onOpenStashes ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenStashes}
          className="gap-1.5"
        >
          <Icon name="archive-stack" className="size-4" />
          {"Stashes"}
        </Button>
      ) : null}
    </div>
  );
};
