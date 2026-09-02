import React from 'react';

import { parsePiThinkingLevel } from '@/lib/pi/thinking';
import type { PiThinkingLevel } from '@/lib/pi/types';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ThinkingLevelPicker } from '../ThinkingLevelControl';

export interface MobileVariantPanelProps {
  open: boolean;
  onClose: () => void;
  targetVariants: readonly PiThinkingLevel[];
  selectedVariant: string | undefined;
  onVariantLiveChange: (level: PiThinkingLevel | undefined) => void;
  onVariantCommit: (level: PiThinkingLevel | undefined) => void;
}

export const MobileVariantPanel: React.FC<MobileVariantPanelProps> = ({
  open,
  onClose,
  targetVariants,
  selectedVariant,
  onVariantLiveChange,
  onVariantCommit,
}) => {
  if (!open || targetVariants.length === 0) return null;

  return (
    <MobileOverlayPanel open={true} onClose={onClose} title="Thinking">
      <ThinkingLevelPicker
        levels={targetVariants}
        value={parsePiThinkingLevel(selectedVariant) ?? undefined}
        onChange={onVariantLiveChange}
        onCommit={onVariantCommit}
      />
    </MobileOverlayPanel>
  );
};
