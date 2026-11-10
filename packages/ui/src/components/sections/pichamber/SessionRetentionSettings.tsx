import React from 'react';
import { toast } from '@/components/ui';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsInset,
  SETTINGS_ICON_BUTTON_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_ACTION_OPTIONS: Array<{ value: 'archive' | 'delete'; label: string }> = [
  { value: 'archive', label: "Archive" },
  { value: 'delete', label: "Delete" },
];

export const SessionRetentionSettings: React.FC = () => {
    const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const setAutoDeleteEnabled = useUIStore((state) => state.setAutoDeleteEnabled);
  const setAutoDeleteAfterDays = useUIStore((state) => state.setAutoDeleteAfterDays);
  const setSessionRetentionAction = useUIStore((state) => state.setSessionRetentionAction);

  const { archiveCandidates, deleteCandidates, isRunning, runCleanup } = useSessionAutoCleanup({ autoRun: false });

  const handleRunCleanup = React.useCallback(async () => {
    const result = await runCleanup();
    const sessions = (count: number) => (count === 1 ? '1 session' : `${count} sessions`);
    const archivedCount = result.archive.completedIds.length;
    const deletedCount = result.delete.completedIds.length;
    const failedArchive = result.archive.failedIds.length;
    const failedDelete = result.delete.failedIds.length;

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
    if (archivedCount > 0) toast.success(`Archived ${sessions(archivedCount)}`);
    if (deletedCount > 0) toast.success(`Deleted ${sessions(deletedCount)}`);
    if (failedArchive > 0) toast.error(`Could not archive ${sessions(failedArchive)}`);
    if (failedDelete > 0) toast.error(`Could not delete ${sessions(failedDelete)}`);
  }, [runCleanup]);

  return (
    <SettingsSection
      title={"Session retention"}
      info={"Automatically archive or delete inactive sessions based on last activity. Keeps the 5 most recent sessions. This changes the sessions themselves; Settle idle sessions in Appearance only tidies the Threads and By folder sidebar."}
    >
      <SettingsCheckboxRow
        settingsItem="sessions.auto-cleanup"
        checked={autoDeleteEnabled}
        onChange={setAutoDeleteEnabled}
        label={"Enable auto-cleanup"}
        ariaLabel={"Enable auto-cleanup"}
      />

      <SettingsInset className="space-y-0">
        <SettingsFieldRow
          settingsItem="sessions.retention-period"
          label={"Retention period"}
        >
          <NumberInput
            value={autoDeleteAfterDays}
            onValueChange={setAutoDeleteAfterDays}
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            aria-label={"Retention period in days"}
            className="w-20 tabular-nums"
          />
          <span className="typography-ui-label text-muted-foreground">{"days"}</span>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => setAutoDeleteAfterDays(DEFAULT_RETENTION_DAYS)}
            disabled={autoDeleteAfterDays === DEFAULT_RETENTION_DAYS}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={"Reset retention period"}
            title={"Reset"}
          >
            <Icon name="restart" className="h-3.5 w-3.5" />
          </Button>
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="sessions.retention-action"
          label={"When sessions expire"}
        >
          <SettingsChipGroup
            value={sessionRetentionAction}
            onChange={setSessionRetentionAction}
            options={RETENTION_ACTION_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />
        </SettingsFieldRow>
      </SettingsInset>

      <div className="mt-1 py-1.5 space-y-1">
        <SettingsFieldRow
          label={"Manual cleanup"}
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleRunCleanup}
            disabled={isRunning}
            className="!font-normal"
          >
            {isRunning ? "Cleaning up..." : "Run cleanup now"}
          </Button>
        </SettingsFieldRow>
        <p className="typography-meta text-muted-foreground">
          {`Ready to archive: ${archiveCandidates.length}. Ready to delete: ${deleteCandidates.length}.`}
        </p>
      </div>
    </SettingsSection>
  );
};
