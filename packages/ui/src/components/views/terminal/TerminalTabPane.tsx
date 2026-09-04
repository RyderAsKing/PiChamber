import React from 'react';

import { EMPTY_TERMINAL_BUFFER, useTerminalStore } from '@/stores/useTerminalStore';
import type { TerminalAPI } from '@/lib/api/types';
import type { TerminalTheme } from '@/lib/terminalTheme';
import {
  TerminalViewport,
  type TerminalController,
} from '@/components/terminal/TerminalViewport';
import { cn } from '@/lib/utils';

type Props = {
  directory: string;
  tabId: string;
  sessionId: string | null;
  sessionKey: string;
  isActive: boolean;
  isTerminalVisible: boolean;
  terminal: TerminalAPI;
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  enableTouchScroll: boolean;
  lastViewportSizeRef: React.MutableRefObject<{ cols: number; rows: number } | null>;
  onInput: (data: string) => void;
  controllerRef?: React.MutableRefObject<TerminalController | null>;
};

/**
 * One mounted renderer per terminal tab. Panes stay mounted while hidden so a
 * full-screen program keeps its VT state across tab switches; only the active
 * pane draws, focuses, and reports sizes.
 */
export const TerminalTabPane: React.FC<Props> = ({
  directory,
  tabId,
  sessionId,
  sessionKey,
  isActive,
  isTerminalVisible,
  terminal,
  theme,
  fontFamily,
  fontSize,
  enableTouchScroll,
  lastViewportSizeRef,
  onInput,
  controllerRef,
}) => {
  const chunks = useTerminalStore((s) =>
    directory && tabId ? s.getBuffer(directory, tabId).chunks : EMPTY_TERMINAL_BUFFER.chunks,
  );
  const innerRef = React.useRef<TerminalController | null>(null);
  const visible = isActive && isTerminalVisible;

  const setController = React.useCallback(
    (controller: TerminalController | null) => {
      innerRef.current = controller;
      if (controllerRef) controllerRef.current = isActive ? controller : controllerRef.current;
      if (!isActive && controllerRef && controllerRef.current === controller) {
        controllerRef.current = null;
      }
    },
    [controllerRef, isActive],
  );

  React.useEffect(() => {
    if (!isActive || !isTerminalVisible) return;
    const frame = requestAnimationFrame(() => {
      innerRef.current?.fit();
    });
    return () => cancelAnimationFrame(frame);
  }, [isActive, isTerminalVisible, sessionKey, sessionId]);

  const handleResize = React.useCallback(
    (cols: number, rows: number) => {
      if (!isActive) return;
      const previous = lastViewportSizeRef.current;
      if (!previous || previous.cols !== cols || previous.rows !== rows) {
        lastViewportSizeRef.current = { cols, rows };
      }
      if (!sessionId) return;
      void terminal.resize({ sessionId, cols, rows }).catch(() => {});
    },
    [isActive, lastViewportSizeRef, sessionId, terminal],
  );

  return (
    <div className={cn('h-full w-full', isActive ? 'block' : 'hidden')} aria-hidden={!isActive}>
      <TerminalViewport
        key={sessionKey}
        ref={setController}
        sessionKey={sessionKey}
        chunks={chunks}
        onInput={onInput}
        onResize={handleResize}
        theme={theme}
        fontFamily={fontFamily}
        fontSize={fontSize}
        enableTouchScroll={enableTouchScroll}
        autoFocus={visible}
        isVisible={visible}
      />
    </div>
  );
};
