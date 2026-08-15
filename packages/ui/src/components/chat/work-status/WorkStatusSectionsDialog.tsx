import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  WORK_STATUS_SECTION_IDS,
  WORK_STATUS_SECTION_LABELS,
  isWorkStatusSectionVisible,
} from './sections';

/**
 * Which sections the work-status panel may show.
 *
 * Everything is on by default and the choice is stored as the *hidden* set, so
 * a section added in a later release appears for everyone rather than staying
 * invisible to whoever had saved settings before it existed.
 */
export const WorkStatusSectionsDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const hidden = useUIStore((state) => state.workStatusHiddenSections);
  const setSectionVisible = useUIStore((state) => state.setWorkStatusSectionVisible);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{"Panel sections"}</DialogTitle>
          <DialogDescription>{"Choose what the work-status panel shows. Hidden sections keep their data — they are only left out of the panel."}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col">
          {WORK_STATUS_SECTION_IDS.map((sectionId) => (
            <SettingsCheckboxRow
              key={sectionId}
              settingsItem={`chat.work-status.section.${sectionId}`}
              checked={isWorkStatusSectionVisible(hidden, sectionId)}
              onChange={(checked) => setSectionVisible(sectionId, checked)}
              label={WORK_STATUS_SECTION_LABELS[sectionId]}
              ariaLabel={WORK_STATUS_SECTION_LABELS[sectionId]}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};
