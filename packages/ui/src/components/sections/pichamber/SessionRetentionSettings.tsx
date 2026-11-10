import React from 'react';
import { toast } from '@/components/ui';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import {
  SettingsSection,
  SettingsFieldRow,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { formatSessionCount } from '@/lib/sessionRetention';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
/** What new installs start with, and what the suggestion turns on. */
const SUGGESTED_ARCHIVE_DAYS = 7;
const SUGGESTED_DELETE_DAYS = 30;

const dayUnit = (days: number): string => (days === 1 ? 'day' : 'days');

interface ArchiveAndDeleteFieldsProps {
  archiveAfterDays: number;
  deleteAfterDays: number;
  onArchiveAfterDaysChange: (days: number) => void;
  onDeleteAfterDaysChange: (days: number) => void;
}

/** The two day settings; 0 is off. Takes values as props so it renders without the store. */
export const ArchiveAndDeleteFields: React.FC<ArchiveAndDeleteFieldsProps> = ({
  archiveAfterDays,
  deleteAfterDays,
  onArchiveAfterDaysChange,
  onDeleteAfterDaysChange,
}) => {
  const archiveOff = archiveAfterDays === 0;
  const deleteOff = deleteAfterDays === 0;
  // The example uses the current values when both are on, else the suggested ones.
  const showsCurrent = !archiveOff && !deleteOff;
  const exampleArchiveDays = showsCurrent ? archiveAfterDays : SUGGESTED_ARCHIVE_DAYS;
  const exampleDeleteDays = showsCurrent ? deleteAfterDays : SUGGESTED_DELETE_DAYS;
  const deleteInfo = `Only archived sessions are deleted, counted from the day each one was archived. ${
    showsCurrent ? 'With these settings' : `With archiving at ${exampleArchiveDays} days and deleting at ${exampleDeleteDays}`
  }, a session is deleted ${exampleArchiveDays + exampleDeleteDays} days after you last used it.`;

  return (
    <>
      <SettingsFieldRow
        settingsItem="sessions.auto-archive"
        label={"Archive idle sessions after"}
        info={"Pinned, running, and snoozed sessions, sessions waiting on you, and the open session are never archived automatically. Leave empty to archive only by hand."}
        description={archiveOff
          ? `Suggested: ${SUGGESTED_ARCHIVE_DAYS} days, so the sidebar shows what you're working on.`
          : undefined}
      >
        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
          <NumberInput
            value={archiveOff ? undefined : archiveAfterDays}
            fallbackValue={SUGGESTED_ARCHIVE_DAYS}
            onValueChange={onArchiveAfterDaysChange}
            onClear={() => onArchiveAfterDaysChange(0)}
            emptyLabel={'Off'}
            placeholder={'Off'}
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            aria-label={"Days before an idle session is archived"}
            className="w-20 tabular-nums"
          />
          <span className={SETTINGS_NUMBER_UNIT_CLASS}>{dayUnit(archiveAfterDays)}</span>
          {archiveOff ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="ml-1 !font-normal"
              onClick={() => onArchiveAfterDaysChange(SUGGESTED_ARCHIVE_DAYS)}
            >
              {"Turn on"}
            </Button>
          ) : null}
        </div>
      </SettingsFieldRow>

      <SettingsFieldRow
        settingsItem="sessions.auto-delete"
        label={"Delete archived sessions"}
        info={deleteInfo}
        description={deleteOff ? undefined : "Deleted sessions can't be restored."}
      >
        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
          <NumberInput
            value={deleteOff ? undefined : deleteAfterDays}
            fallbackValue={SUGGESTED_DELETE_DAYS}
            onValueChange={onDeleteAfterDaysChange}
            onClear={() => onDeleteAfterDaysChange(0)}
            emptyLabel={'Off'}
            placeholder={'Off'}
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            aria-label={"Days after archiving before a session is deleted"}
            className="w-20 tabular-nums"
          />
          <span className={SETTINGS_NUMBER_UNIT_CLASS}>{`${dayUnit(deleteAfterDays)} after archiving`}</span>
        </div>
      </SettingsFieldRow>
    </>
  );
};

/**
 * Auto-archive and auto-delete (`sessionAutoArchiveAfterDays`,
 * `sessionAutoDeleteAfterDays`; 0 is off). The passes themselves run in
 * `useSessionAutoCleanup`; this page only edits the two values and offers a
 * manual run.
 */
export const SessionRetentionSettings: React.FC = () => {
  const archiveAfterDays = useUIStore((state) => state.sessionAutoArchiveAfterDays);
  const deleteAfterDays = useUIStore((state) => state.sessionAutoDeleteAfterDays);
  const setArchiveAfterDays = useUIStore((state) => state.setSessionAutoArchiveAfterDays);
  const setDeleteAfterDays = useUIStore((state) => state.setSessionAutoDeleteAfterDays);

  const changeArchiveAfterDays = React.useCallback((days: number) => {
    setArchiveAfterDays(days);
    void updateDesktopSettings({ sessionAutoArchiveAfterDays: days });
  }, [setArchiveAfterDays]);
  const changeDeleteAfterDays = React.useCallback((days: number) => {
    setDeleteAfterDays(days);
    void updateDesktopSettings({ sessionAutoDeleteAfterDays: days });
  }, [setDeleteAfterDays]);

  const { archiveCandidates, deleteCandidates, isRunning, runCleanup } = useSessionAutoCleanup({ autoRun: false });

  const handleRunCleanup = React.useCallback(async () => {
    const result = await runCleanup();
    const archivedCount = result.archive.completedIds.length;
    const deletedCount = result.delete.completedIds.length;
    const failedArchive = result.archive.failedIds.length;
    const failedDelete = result.delete.failedIds.length;

    if (result.skippedReason === 'running') {
      toast.message("Archive and delete is already running. Try again in a moment.");
      return;
    }
    if (result.skippedReason === 'disabled') {
      toast.message("Archiving and deleting are both off");
      return;
    }
    if (archivedCount + deletedCount + failedArchive + failedDelete === 0) {
      toast.message(
        result.skippedReason === 'partial' || result.skippedReason === 'stale'
          ? "Could not check every folder. Try again later."
          : "No sessions to archive or delete"
      );
      return;
    }
    if (archivedCount > 0) toast.success(`Archived ${formatSessionCount(archivedCount)}`);
    if (deletedCount > 0) toast.success(`Deleted ${formatSessionCount(deletedCount)}`);
    if (failedArchive > 0) toast.error(`Could not archive ${formatSessionCount(failedArchive)}`);
    if (failedDelete > 0) toast.error(`Could not delete ${formatSessionCount(failedDelete)}`);
  }, [runCleanup]);

  return (
    <SettingsSection
      title={"Archive and delete"}
      contentClassName="space-y-4"
      info={"Archived sessions leave Workspace, By folder, and Threads. Search and Timeline still show them, and sending a message brings one back."}
    >
      <ArchiveAndDeleteFields
        archiveAfterDays={archiveAfterDays}
        deleteAfterDays={deleteAfterDays}
        onArchiveAfterDaysChange={changeArchiveAfterDays}
        onDeleteAfterDaysChange={changeDeleteAfterDays}
      />

      <SettingsFieldRow
        settingsItem="sessions.auto-cleanup"
        label={"Run now"}
        description={`Ready to archive: ${archiveCandidates.length}. Ready to delete: ${deleteCandidates.length}.`}
      >
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleRunCleanup}
          disabled={isRunning}
          className="!font-normal"
        >
          {isRunning ? "Running..." : "Archive and delete now"}
        </Button>
      </SettingsFieldRow>
    </SettingsSection>
  );
};
