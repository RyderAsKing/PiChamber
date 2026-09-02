import React from 'react';
import type { GitAPI } from '@/lib/api/types';
import type { ToolPart } from '@/lib/chat/types';
import { extractChangedFiles } from '@/components/chat/changedFiles';
import { projectTurnRecords } from '@/components/chat/lib/turns/projectTurnRecords';
import type { DiffData, DiffScope, TurnSnapshotDiff } from './diffTypes';
import { createTextDiffDataFromPatch } from './diffFormatters';
import { DEFAULT_CONTEXT_DIFF_LINES } from './diffConstants';
import { listTurnDiffs, parseRangeDiff } from './diffTurnUtils';

export function useBranchAndTurnDiffs({
  activeDiffScope,
  effectiveDirectory,
  branchBase,
  branchHead,
  git,
  sessionMessageRecords,
}: {
  activeDiffScope: DiffScope;
  effectiveDirectory: string | null | undefined;
  branchBase: string | null;
  branchHead: string | null;
  git: GitAPI;
  sessionMessageRecords: any[];
}) {
  const [branchDiffs, setBranchDiffs] = React.useState<TurnSnapshotDiff[]>([]);
  const [branchDiffError, setBranchDiffError] = React.useState<string | null>(null);
  const [branchDiffLoading, setBranchDiffLoading] = React.useState(false);

  const lastTurnDiffs = React.useMemo<TurnSnapshotDiff[]>(() => {
    const projection = projectTurnRecords(sessionMessageRecords, {
      showTextJustificationActivity: false,
      showTurnChangedFiles: true,
      mergeHiddenUserTurns: true,
    });

    for (let index = projection.turns.length - 1; index >= 0; index -= 1) {
      const turn = projection.turns[index];
      if (!turn) continue;

      const toolParts = turn.activityParts
        .map((activity) => activity.part)
        .filter((part): part is ToolPart => part.type === 'tool');
      const changedFiles = extractChangedFiles(toolParts);
      if (changedFiles.length > 0) {
        return changedFiles.map((file) => ({
          file: file.path,
          status: 'modified' as const,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
        }));
      }

      const summaryDiffs = listTurnDiffs(
        (turn.userMessage.info as { summary?: { diffs?: unknown } })?.summary?.diffs,
      );
      if (summaryDiffs.length > 0) {
        return summaryDiffs;
      }
    }

    return [];
  }, [sessionMessageRecords]);

  React.useEffect(() => {
    if (
      activeDiffScope !== 'branch' ||
      !effectiveDirectory ||
      !branchBase ||
      !branchHead ||
      !git.getGitRangeDiff
    ) {
      setBranchDiffs([]);
      setBranchDiffError(null);
      setBranchDiffLoading(false);
      return;
    }

    let cancelled = false;
    setBranchDiffLoading(true);
    setBranchDiffError(null);
    void git
      .getGitRangeDiff(effectiveDirectory, {
        base: branchBase,
        head: branchHead,
        contextLines: DEFAULT_CONTEXT_DIFF_LINES,
      })
      .then((response) => {
        if (cancelled) return;
        setBranchDiffs(parseRangeDiff(response.diff ?? ''));
        setBranchDiffLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setBranchDiffs([]);
        setBranchDiffLoading(false);
        setBranchDiffError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [activeDiffScope, branchBase, branchHead, effectiveDirectory, git]);

  const lastTurnDiffData = React.useMemo(() => {
    const map = new Map<string, DiffData>();
    for (const diff of lastTurnDiffs) {
      if (!diff.file) continue;
      if (typeof diff.patch === 'string') {
        map.set(diff.file, createTextDiffDataFromPatch(diff.file, diff.patch, 'patch'));
        continue;
      }
      map.set(diff.file, {
        original: diff.before ?? '',
        modified: diff.after ?? '',
        contextMode: 'full',
      });
    }
    return map;
  }, [lastTurnDiffs]);

  const branchDiffData = React.useMemo(() => {
    const map = new Map<string, DiffData>();
    for (const diff of branchDiffs) {
      if (!diff.file || typeof diff.patch !== 'string') continue;
      map.set(diff.file, createTextDiffDataFromPatch(diff.file, diff.patch, 'patch'));
    }
    return map;
  }, [branchDiffs]);

  return {
    branchDiffs,
    branchDiffError,
    branchDiffLoading,
    lastTurnDiffs,
    lastTurnDiffData,
    branchDiffData,
  };
}
