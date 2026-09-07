import React from 'react';
import type { Message, Part } from '@/lib/chat/types';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from './types';
import {
  readExpandedToolsCache,
  writeExpandedToolsCache,
} from './chatToolExpansion';

/**
 * Tool disclosure is manual-only: bash/edit tools never auto-open.
 * Manual expansion, execution, and results are preserved through the
 * per-message expanded cache.
 */
export function useChatMessageToolsState({
  message,
  toolParts: _toolParts,
  turnActivityToolParts: _turnActivityToolParts,
}: {
  message: { info: Message };
  toolParts: Part[];
  turnActivityToolParts: Part[];
}) {
  void _toolParts;
  void _turnActivityToolParts;
  const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);

  const [expandedTools, setExpandedTools] = React.useState<Set<string>>(() =>
    readExpandedToolsCache(message.info.id),
  );
  const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
    open: false,
    title: '',
    content: '',
  });

  React.useEffect(() => {
    setExpandedTools(readExpandedToolsCache(message.info.id));
  }, [message.info.id]);

  const effectiveExpandedTools = expandedTools;

  const handleToggleTool = React.useCallback(
    (toolId: string) => {
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
    },
    [message.info.id],
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
