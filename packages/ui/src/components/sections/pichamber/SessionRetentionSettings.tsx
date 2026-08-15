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

  const { candidates, isRunning, runCleanup, action } = useSessionAutoCleanup({ autoRun: false });
  const pendingCount = candidates.length;

  const handleRunCleanup = React.useCallback(async () => {
    const result = await runCleanup({ force: true });

    if (result.completedIds.length === 0 && result.failedIds.length === 0) {
      toast.message(
        result.action === 'archive'
          ? "No sessions eligible for archiving"
          : "No sessions eligible for deletion"
      );
      return;
    }
    if (result.completedIds.length > 0) {
      toast.success(
        result.action === 'archive'
          ? `Archived ${result.completedIds.length} session(s)`
          : `Deleted ${result.completedIds.length} session(s)`
      );
    }
    if (result.failedIds.length > 0) {
      toast.error(
        result.action === 'archive'
          ? `Failed to archive ${result.failedIds.length} session(s)`
          : `Failed to delete ${result.failedIds.length} session(s)`
      );
    }
  }, [runCleanup]);

  return (
    <SettingsSection
      title={"Session Retention"}
      info={"Automatically archive or delete inactive sessions based on last activity. Keeps the 5 most recent sessions."}
    >
      <SettingsCheckboxRow
        settingsItem="sessions.auto-cleanup"
        checked={autoDeleteEnabled}
        onChange={setAutoDeleteEnabled}
        label={"Enable Auto-Cleanup"}
        ariaLabel={"Enable auto-cleanup"}
      />

      <SettingsInset className="space-y-0">
        <SettingsFieldRow
          settingsItem="sessions.retention-period"
          label={"Retention Period"}
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
          label={"Manual Cleanup"}
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
          {action === 'archive'
            ? `Eligible for archiving right now: ${pendingCount}`
            : `Eligible for deletion right now: ${pendingCount}`}
        </p>
      </div>
    </SettingsSection>
  );
};
