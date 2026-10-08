import React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

export interface ComposerDragOverlayProps {
  isInternalDrag: boolean;
  iconButtonBaseClass: string;
  iconSizeClass: string;
  radius: string;
  /**
   * Same authoritative attachment gate as the footer triggers and picker
   * callback. The overlay can render while locked (drop stays enabled for
   * a session/draft), so the button must expose a real disabled state
   * instead of an enabled no-op.
   */
  isAttachmentDisabled: boolean;
  onPickLocalFiles: () => void;
}

export const ComposerDragOverlay: React.FC<ComposerDragOverlayProps> = ({
  isInternalDrag,
  iconButtonBaseClass,
  iconSizeClass,
  radius,
  isAttachmentDisabled,
  onPickLocalFiles,
}) => {
  const { t } = useTranslation();
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
            disabled={isAttachmentDisabled}
            title={t("Attach files")}
            aria-label={t("Attach files")}
          >
            <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
          </button>
        </div>
        <p className="mt-2 typography-ui-label text-muted-foreground">
          {isInternalDrag ? t('Drop to insert as mention') : t('Drop files here to attach')}
        </p>
      </div>
    </div>
  );
};
