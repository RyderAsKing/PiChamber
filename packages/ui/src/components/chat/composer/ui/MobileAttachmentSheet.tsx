import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';

export interface MobileAttachmentSheetProps {
  open: boolean;
  onClose: () => void;
  onPickFiles: () => void;
}

export const MobileAttachmentSheet: React.FC<MobileAttachmentSheetProps> = ({
  open,
  onClose,
  onPickFiles,
}) => {
  return (
    <MobileOverlayPanel open={open} title="Add attachment" onClose={onClose}>
      <div className="flex flex-col px-3 pb-4 pt-1">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
          onClick={onPickFiles}
        >
          <Icon name="attachment-2" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
          {'Attach files'}
        </button>
      </div>
    </MobileOverlayPanel>
  );
};
