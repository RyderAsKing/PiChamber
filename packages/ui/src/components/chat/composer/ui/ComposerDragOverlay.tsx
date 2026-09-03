import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

export interface ComposerDragOverlayProps {
  isInternalDrag: boolean;
  iconButtonBaseClass: string;
  iconSizeClass: string;
  radius: string;
  onPickLocalFiles: () => void;
}

export const ComposerDragOverlay: React.FC<ComposerDragOverlayProps> = ({
  isInternalDrag,
  iconButtonBaseClass,
  iconSizeClass,
  radius,
  onPickLocalFiles,
}) => {
  return (
    <div
      className="absolute -inset-px z-50 flex items-center justify-center border border-border/80 bg-[var(--surface-subtle)]/90"
      style={{ borderRadius: radius }}
    >
      <div className="text-center">
        <div className="inline-flex justify-center">
          <button
            type="button"
            className={iconButtonBaseClass}
            onClick={onPickLocalFiles}
            title="Attach files"
            aria-label="Attach files"
          >
            <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
          </button>
        </div>
        <p className="mt-2 typography-ui-label text-muted-foreground">
          {isInternalDrag ? 'Drop to insert as mention' : 'Drop files here to attach'}
        </p>
      </div>
    </div>
  );
};
