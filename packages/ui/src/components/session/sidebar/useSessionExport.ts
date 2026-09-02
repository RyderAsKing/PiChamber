import React from 'react';
import type { Session } from '@/lib/chat/types';
import type { SessionNode } from './types';
import { toast } from '@/components/ui';
import {
  buildExportFilename,
  downloadAsMarkdown,
  formatSessionAsMarkdown,
  getExportRevealLabel,
  revealExportedMarkdown,
  saveAsMarkdownDesktop,
  type ChildSessionExport,
} from '@/lib/exportSession';
import {
  buildSessionMessageRecordsSnapshot,
  useDirectoryStore,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';

export const collectNodeDescendantIds = (root: SessionNode): string[] => {
  const out: string[] = [];
  const walk = (n: SessionNode) => {
    n.children.forEach((child) => {
      out.push(child.session.id);
      walk(child);
    });
  };
  walk(root);
  return out;
};

export const collectNodeDescendantSessions = (root: SessionNode): Session[] => {
  const out: Session[] = [];
  const walk = (current: SessionNode) => {
    current.children.forEach((child) => {
      out.push(child.session);
      walk(child);
    });
  };
  walk(root);
  return out;
};

export function useSessionExport(
  node: SessionNode,
  sessionDirectory: string | null
) {
  const sync = useSync();
  const directoryStore = useDirectoryStore(sessionDirectory ?? undefined, {
    bootstrap: false,
  });
  const [exportDialogOpen, setExportDialogOpen] = React.useState(false);
  const [exportIncludeSubtasks, setExportIncludeSubtasks] = React.useState(true);

  const session = node.session;
  const descendantCount = React.useMemo(
    () => collectNodeDescendantIds(node).length,
    [node]
  );

  const collectChildExports = React.useCallback(
    async (
      children: SessionNode[]
    ): Promise<{ children: ChildSessionExport[]; skipped: number }> => {
      const results: ChildSessionExport[] = [];
      let skipped = 0;
      for (const child of children) {
        try {
          if (!sessionDirectory)
            throw new Error('Session directory is required for export');
          await (sync as any).loadCompleteHistory?.(
            child.session.id,
            sessionDirectory
          );
          const childRecords = buildSessionMessageRecordsSnapshot(
            directoryStore.getState(),
            child.session.id
          ).list;
          const childTitle = child.session.title || "Untitled Sub-agent";
          const childAgent = (child.session as Session & { agent?: string }).agent;
          const grandChildren = await collectChildExports(child.children);
          skipped += grandChildren.skipped;
          results.push({
            title: childTitle,
            agent: childAgent,
            records: childRecords,
            children: grandChildren.children,
          });
        } catch {
          skipped += collectNodeDescendantIds(child).length + 1;
        }
      }
      return { children: results, skipped };
    },
    [directoryStore, sessionDirectory, sync]
  );

  const showSkippedSubtasksWarning = React.useCallback((count: number) => {
    if (count <= 0) return;
    toast.warning(
      count === 1
        ? `Exported session, but skipped ${count} sub-agent task that could not be loaded.`
        : `Exported session, but skipped ${count} sub-agent tasks that could not be loaded.`
    );
  }, []);

  const doExportSession = React.useCallback(
    async (includeSubtasks: boolean) => {
      if (!sessionDirectory) {
        toast.error("Nothing to export");
        return;
      }

      try {
        await (sync as any).loadCompleteHistory?.(session.id, sessionDirectory);
      } catch {
        toast.error("Failed to load the complete session history");
        return;
      }

      const records = buildSessionMessageRecordsSnapshot(
        directoryStore.getState(),
        session.id
      ).list;
      if (records.length === 0) {
        toast.error("Nothing to export");
        return;
      }

      let childExports: ChildSessionExport[] | undefined;
      let skippedSubtaskCount = 0;
      if (includeSubtasks && node.children.length > 0) {
        const collected = await collectChildExports(node.children);
        childExports = collected.children;
        skippedSubtaskCount = collected.skipped;
      }

      const markdown = formatSessionAsMarkdown(
        records,
        session.title ?? null,
        childExports
      );
      const filename = buildExportFilename(session.title ?? null);
      const savedPath = await saveAsMarkdownDesktop(markdown, filename);

      if (savedPath) {
        toast.success("Session exported", {
          action: {
            label: getExportRevealLabel(),
            onClick: () => {
              void revealExportedMarkdown(savedPath).then((revealed) => {
                if (!revealed) {
                  toast.error("Failed to reveal path");
                }
              });
            },
          },
        });
        showSkippedSubtasksWarning(skippedSubtaskCount);
        return;
      }

      downloadAsMarkdown(markdown, filename);
      toast.success("Session exported");
      showSkippedSubtasksWarning(skippedSubtaskCount);
    },
    [
      collectChildExports,
      directoryStore,
      node.children,
      session.id,
      session.title,
      sessionDirectory,
      showSkippedSubtasksWarning,
      sync,
    ]
  );

  const handleExportSession = React.useCallback(async () => {
    if (node.children.length > 0) {
      setExportIncludeSubtasks(true);
      setExportDialogOpen(true);
      return;
    }
    await doExportSession(false);
  }, [doExportSession, node.children.length]);

  return {
    exportDialogOpen,
    setExportDialogOpen,
    exportIncludeSubtasks,
    setExportIncludeSubtasks,
    descendantCount,
    handleExportSession,
    doExportSession,
  };
}
