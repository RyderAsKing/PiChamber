import React from 'react';
import type { Message, Part } from '@/lib/chat/types';
import { useUIStore } from '@/stores/useUIStore';
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

export function useChatMessageToolsState({
  message,
  toolParts,
  turnActivityToolParts,
  showExpandedBashTools,
  showExpandedEditTools,
}: {
  message: { info: Message };
  toolParts: Part[];
  turnActivityToolParts: Part[];
  showExpandedBashTools: boolean;
  showExpandedEditTools: boolean;
}) {
  const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);

  const [expandedTools, setExpandedTools] = React.useState<Set<string>>(() =>
    readExpandedToolsCache(message.info.id),
  );
  const [collapsedTools, setCollapsedTools] = React.useState<Set<string>>(() =>
    readCollapsedToolsCache(message.info.id),
  );
  const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
    open: false,
    title: '',
    content: '',
  });

  React.useEffect(() => {
    setExpandedTools(readExpandedToolsCache(message.info.id));
    setCollapsedTools(readCollapsedToolsCache(message.info.id));
  }, [message.info.id]);

  const defaultOpenToolIds = React.useMemo(() => {
    if (!showExpandedBashTools && !showExpandedEditTools) {
      return new Set<string>();
    }

    const next = new Set<string>();
    for (const part of [...toolParts, ...turnActivityToolParts]) {
      const toolId = typeof part?.id === 'string' ? part.id : '';
      if (!toolId) continue;
      const toolName = normalizeToolName((part as { tool?: string }).tool);
      if (!toolName) continue;

      if (showExpandedBashTools && BASH_TOOL_NAMES.has(toolName)) {
        next.add(toolId);
        continue;
      }
      if (showExpandedEditTools && EDIT_TOOL_NAMES.has(toolName)) {
        next.add(toolId);
      }
    }

    return next;
  }, [showExpandedBashTools, showExpandedEditTools, toolParts, turnActivityToolParts]);

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
    collapsedTools.forEach((toolId) => {
      next.delete(toolId);
    });
    return next;
  }, [collapsedTools, defaultOpenToolIds, expandedTools]);

  const handleToggleTool = React.useCallback(
    (toolId: string) => {
      const isDefaultOpen = defaultOpenToolIds.has(toolId);
      const isCurrentlyExpanded = effectiveExpandedTools.has(toolId);

      if (isDefaultOpen) {
        setCollapsedTools((prev) => {
          const next = new Set(prev);
          if (isCurrentlyExpanded) {
            next.add(toolId);
          } else {
            next.delete(toolId);
          }
          writeCollapsedToolsCache(message.info.id, next);
          return next;
        });

        if (!isCurrentlyExpanded) {
          setExpandedTools((prev) => {
            const next = new Set(prev);
            next.delete(toolId);
            writeExpandedToolsCache(message.info.id, next);
            return next;
          });
        }
        return;
      }

      setExpandedTools((prev) => {
        const next = new Set(prev);
        if (next.has(toolId)) {
          next.delete(toolId);
        } else {
          next.add(toolId);
        }
        writeExpandedToolsCache(message.info.id, next);
        return next;
      });

      setCollapsedTools((prev) => {
        if (!prev.has(toolId)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(toolId);
        writeCollapsedToolsCache(message.info.id, next);
        return next;
      });
    },
    [defaultOpenToolIds, effectiveExpandedTools, message.info.id],
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
      setPopupContent((prev) => ({ ...prev, open }));
      setImagePreviewOpen(open);
    },
    [setImagePreviewOpen],
  );

  return {
    expandedTools,
    effectiveExpandedTools,
    popupContent,
    handleToggleTool,
    handleShowPopup,
    handlePopupChange,
  };
}
