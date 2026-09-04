import React from 'react';
import type { Part } from '@/lib/chat/types';
import { useUIStore } from '@/stores/useUIStore';
import type { TurnActivityRecord } from '../lib/turns/types';
import type { ToolPopupContent } from './types';
import {
  BASH_TOOL_NAMES,
  EDIT_TOOL_NAMES,
  normalizeToolName,
  readCollapsedToolsCache,
  readExpandedToolsCache,
  writeCollapsedToolsCache,
  writeExpandedToolsCache,
} from './chatToolExpansion';

type ToolActivity = TurnActivityRecord & { kind: 'tool'; part: Part & { type: 'tool' } };

type ToolCacheState = {
  expanded: Set<string>;
  collapsed: Set<string>;
};

const readTurnToolCache = (activities: ToolActivity[]): ToolCacheState => {
  const expanded = new Set<string>();
  const collapsed = new Set<string>();
  const toolIdsByMessage = new Map<string, Set<string>>();

  for (const activity of activities) {
    const ids = toolIdsByMessage.get(activity.messageId) ?? new Set<string>();
    ids.add(activity.id);
    toolIdsByMessage.set(activity.messageId, ids);
  }

  for (const [messageId, toolIds] of toolIdsByMessage) {
    const cachedExpanded = readExpandedToolsCache(messageId);
    const cachedCollapsed = readCollapsedToolsCache(messageId);
    for (const toolId of toolIds) {
      if (cachedExpanded.has(toolId)) expanded.add(toolId);
      if (cachedCollapsed.has(toolId)) collapsed.add(toolId);
    }
  }

  return { expanded, collapsed };
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

export function useTurnToolsState({
  activities,
  showExpandedBashTools,
  showExpandedEditTools,
}: {
  activities: TurnActivityRecord[];
  showExpandedBashTools: boolean;
  showExpandedEditTools: boolean;
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
    readTurnToolCache(toolActivities).expanded,
  );
  const [collapsedTools, setCollapsedTools] = React.useState<Set<string>>(() =>
    readTurnToolCache(toolActivities).collapsed,
  );
  const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
    open: false,
    title: '',
    content: '',
  });

  const defaultOpenToolIds = React.useMemo(() => {
    if (!showExpandedBashTools && !showExpandedEditTools) {
      return new Set<string>();
    }

    const next = new Set<string>();
    for (const activity of toolActivities) {
      const toolName = normalizeToolName(activity.part.tool);
      if (!toolName) continue;

      if (showExpandedBashTools && BASH_TOOL_NAMES.has(toolName)) {
        next.add(activity.id);
        continue;
      }
      if (showExpandedEditTools && EDIT_TOOL_NAMES.has(toolName)) {
        next.add(activity.id);
      }
    }
    return next;
  }, [showExpandedBashTools, showExpandedEditTools, toolActivities]);

  const effectiveExpandedTools = React.useMemo(() => {
    if (defaultOpenToolIds.size === 0 && collapsedTools.size === 0) {
      return expandedTools;
    }

    const next = new Set(expandedTools);
    defaultOpenToolIds.forEach((toolId) => {
      if (!collapsedTools.has(toolId)) {
        next.add(toolId);
      }
    });
    collapsedTools.forEach((toolId) => next.delete(toolId));
    return next;
  }, [collapsedTools, defaultOpenToolIds, expandedTools]);

  const toggleStateRef = React.useRef({
    ownerByToolId,
    toolIdsByOwner,
    defaultOpenToolIds,
    effectiveExpandedTools,
  });
  toggleStateRef.current = {
    ownerByToolId,
    toolIdsByOwner,
    defaultOpenToolIds,
    effectiveExpandedTools,
  };

  const handleToggleTool = React.useCallback(
    (toolId: string) => {
      const current = toggleStateRef.current;
      const ownerId = current.ownerByToolId.get(toolId);
      if (!ownerId) return;

      const ownerToolIds = current.toolIdsByOwner.get(ownerId) ?? new Set<string>();
      const isDefaultOpen = current.defaultOpenToolIds.has(toolId);
      const isCurrentlyExpanded = current.effectiveExpandedTools.has(toolId);

      if (isDefaultOpen) {
        setCollapsedTools((previous) => {
          const next = new Set(previous);
          if (isCurrentlyExpanded) {
            next.add(toolId);
          } else {
            next.delete(toolId);
          }
          updateOwnerCache({
            messageId: ownerId,
            ownerToolIds,
            nextValue: next,
            read: readCollapsedToolsCache,
            write: writeCollapsedToolsCache,
          });
          return next;
        });

        if (!isCurrentlyExpanded) {
          setExpandedTools((previous) => {
            const next = new Set(previous);
            next.delete(toolId);
            updateOwnerCache({
              messageId: ownerId,
              ownerToolIds,
              nextValue: next,
              read: readExpandedToolsCache,
              write: writeExpandedToolsCache,
            });
            return next;
          });
        }
        return;
      }

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

      setCollapsedTools((previous) => {
        if (!previous.has(toolId)) return previous;
        const next = new Set(previous);
        next.delete(toolId);
        updateOwnerCache({
          messageId: ownerId,
          ownerToolIds,
          nextValue: next,
          read: readCollapsedToolsCache,
          write: writeCollapsedToolsCache,
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

