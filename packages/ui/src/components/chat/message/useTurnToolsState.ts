import React from 'react';
import type { Part } from '@/lib/chat/types';
import { useUIStore } from '@/stores/useUIStore';
import type { TurnActivityRecord } from '../lib/turns/types';
import type { ToolPopupContent } from './types';
import {
  readExpandedToolsCache,
  writeExpandedToolsCache,
} from './chatToolExpansion';

type ToolActivity = TurnActivityRecord & { kind: 'tool'; part: Part & { type: 'tool' } };

const readTurnToolCache = (activities: ToolActivity[]): Set<string> => {
  const expanded = new Set<string>();
  const toolIdsByMessage = new Map<string, Set<string>>();

  for (const activity of activities) {
    const ids = toolIdsByMessage.get(activity.messageId) ?? new Set<string>();
    ids.add(activity.id);
    toolIdsByMessage.set(activity.messageId, ids);
  }

  for (const [messageId, toolIds] of toolIdsByMessage) {
    const cachedExpanded = readExpandedToolsCache(messageId);
    for (const toolId of toolIds) {
      if (cachedExpanded.has(toolId)) expanded.add(toolId);
    }
  }

  return expanded;
};

const updateOwnerCache = ({
  messageId,
  ownerToolIds,
  nextValue,
  read,
  write,
}: {
  messageId: string;
  ownerToolIds: Set<string>;
  nextValue: Set<string>;
  read: (messageId: string) => Set<string>;
  write: (messageId: string, value: Set<string>) => void;
}): void => {
  // Preserve cached state for tools outside this turn. A message can be
  // revisited from more than one projection, so replacing its whole cache with
  // the turn-local set would silently forget an unrelated tool.
  const cached = read(messageId);
  for (const toolId of ownerToolIds) {
    if (nextValue.has(toolId)) {
      cached.add(toolId);
    } else {
      cached.delete(toolId);
    }
  }
  write(messageId, cached);
};

/**
 * Tool disclosure is manual-only: bash/edit tools never auto-open.
 * Manual expansion, execution, and results are preserved through the
 * per-message expanded cache.
 */
export function useTurnToolsState({
  activities,
}: {
  activities: TurnActivityRecord[];
}) {
  const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
  const toolActivities = React.useMemo<ToolActivity[]>(() => {
    return activities.filter(
      (activity): activity is ToolActivity => activity.kind === 'tool' && activity.part.type === 'tool',
    );
  }, [activities]);

  const ownerByToolId = React.useMemo(() => {
    const owners = new Map<string, string>();
    for (const activity of toolActivities) {
      owners.set(activity.id, activity.messageId);
    }
    return owners;
  }, [toolActivities]);

  const toolIdsByOwner = React.useMemo(() => {
    const owners = new Map<string, Set<string>>();
    for (const activity of toolActivities) {
      const ids = owners.get(activity.messageId) ?? new Set<string>();
      ids.add(activity.id);
      owners.set(activity.messageId, ids);
    }
    return owners;
  }, [toolActivities]);

  const [expandedTools, setExpandedTools] = React.useState<Set<string>>(() =>
    readTurnToolCache(toolActivities),
  );
  const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
    open: false,
    title: '',
    content: '',
  });

  const effectiveExpandedTools = expandedTools;

  const toggleStateRef = React.useRef({
    ownerByToolId,
    toolIdsByOwner,
    effectiveExpandedTools,
  });
  toggleStateRef.current = {
    ownerByToolId,
    toolIdsByOwner,
    effectiveExpandedTools,
  };

  const handleToggleTool = React.useCallback(
    (toolId: string) => {
      const current = toggleStateRef.current;
      const ownerId = current.ownerByToolId.get(toolId);
      if (!ownerId) return;

      const ownerToolIds = current.toolIdsByOwner.get(ownerId) ?? new Set<string>();

      setExpandedTools((previous) => {
        const next = new Set(previous);
        if (next.has(toolId)) {
          next.delete(toolId);
        } else {
          next.add(toolId);
        }
        updateOwnerCache({
          messageId: ownerId,
          ownerToolIds,
          nextValue: next,
          read: readExpandedToolsCache,
          write: writeExpandedToolsCache,
        });
        return next;
      });
    }, [],
  );

  const handleShowPopup = React.useCallback(
    (content: ToolPopupContent) => {
      if (content.image || content.mermaid) {
        setPopupContent(content);
        setImagePreviewOpen(true);
      }
    },
    [setImagePreviewOpen],
  );

  const handlePopupChange = React.useCallback(
    (open: boolean) => {
      setPopupContent((previous) => ({ ...previous, open }));
      setImagePreviewOpen(open);
    },
    [setImagePreviewOpen],
  );

  return {
    effectiveExpandedTools,
    popupContent,
    handleToggleTool,
    handleShowPopup,
    handlePopupChange,
  };
}
