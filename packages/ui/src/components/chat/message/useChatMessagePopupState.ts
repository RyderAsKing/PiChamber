import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from './types';

/**
 * Per-message popup state for image/Mermaid previews opened from message
 * content. Disclosure state for tool rows lives in `useTurnToolsState`
 * (the shared turn activity rail).
 */
export function useChatMessagePopupState() {
  const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);

  const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
    open: false,
    title: '',
    content: '',
  });

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
    popupContent,
    handleShowPopup,
    handlePopupChange,
  };
}
