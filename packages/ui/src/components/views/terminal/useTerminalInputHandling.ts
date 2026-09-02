import React from 'react';
import type { TerminalAPI } from '@/lib/api/types';
import {
  applyTerminalModifier,
  terminalSequenceForKey,
  type TerminalModifier as Modifier,
  type TerminalQuickKey as MobileKey,
} from '@/lib/terminalInput';
import type { TerminalController } from '@/components/terminal/TerminalViewport';
import {
  QUICK_KEY_MAP,
  resolveTerminalControlKey,
} from './terminalStreamHelpers';

export function useTerminalInputHandling({
  terminal,
  terminalIdRef,
  isReconnectPending,
  setConnectionError,
  showQuickKeys,
  isTerminalVisible,
  lastViewportSizeRef,
  terminalSessionId,
  useTouchTerminalInput,
}: {
  terminal: TerminalAPI;
  terminalIdRef: React.MutableRefObject<string | null>;
  isReconnectPending: boolean;
  setConnectionError: React.Dispatch<React.SetStateAction<string | null>>;
  showQuickKeys: boolean;
  isTerminalVisible: boolean;
  lastViewportSizeRef: React.MutableRefObject<{ cols: number; rows: number } | null>;
  terminalSessionId: string | null;
  useTouchTerminalInput: boolean;
}) {
  const [activeModifier, setActiveModifier] = React.useState<Modifier | null>(null);
  const terminalControllerRef = React.useRef<TerminalController | null>(null);

  const focusTerminalController = React.useCallback(() => {
    if (useTouchTerminalInput) {
      return;
    }
    terminalControllerRef.current?.focus();
  }, [useTouchTerminalInput]);

  const focusTerminalWhenWindowActive = React.useCallback(() => {
    if (useTouchTerminalInput) {
      return;
    }
    if (typeof document !== 'undefined' && !document.hasFocus()) {
      return;
    }
    terminalControllerRef.current?.focus();
  }, [useTouchTerminalInput]);

  React.useEffect(() => {
    if (!showQuickKeys && activeModifier !== null) {
      setActiveModifier(null);
    }
  }, [showQuickKeys, activeModifier]);

  React.useEffect(() => {
    if (!terminalSessionId && activeModifier !== null) {
      setActiveModifier(null);
    }
  }, [terminalSessionId, activeModifier]);

  const handleViewportInput = React.useCallback(
    (data: string) => {
      if (!data || isReconnectPending) {
        return;
      }

      let payload = data;
      let modifierConsumed = false;

      if (activeModifier && data.length > 0) {
        payload = applyTerminalModifier(data, activeModifier);
        modifierConsumed = true;
      }

      const terminalId = terminalIdRef.current;
      if (!terminalId) return;

      void terminal.sendInput(terminalId, payload).catch((error: unknown) => {
        if (!isReconnectPending) {
          setConnectionError(error instanceof Error ? error.message : 'Failed to send input');
        }
      });

      if (modifierConsumed) {
        setActiveModifier(null);
        focusTerminalController();
      }
    },
    [activeModifier, focusTerminalController, isReconnectPending, setConnectionError, terminal, terminalIdRef],
  );

  const handleViewportResize = React.useCallback(
    (cols: number, rows: number) => {
      const previous = lastViewportSizeRef.current;
      if (!previous || previous.cols !== cols || previous.rows !== rows) {
        lastViewportSizeRef.current = { cols, rows };
      }
      if (!isTerminalVisible) {
        return;
      }
      const terminalId = terminalIdRef.current;
      if (!terminalId) return;
      void terminal.resize({ sessionId: terminalId, cols, rows }).catch(() => {});
    },
    [isTerminalVisible, lastViewportSizeRef, terminal, terminalIdRef],
  );

  const handleModifierToggle = React.useCallback(
    (modifier: Modifier) => {
      setActiveModifier((current) => (current === modifier ? null : modifier));
      focusTerminalController();
    },
    [focusTerminalController],
  );

  const handleMobileKeyPress = React.useCallback(
    (key: MobileKey) => {
      const sequence = terminalSequenceForKey(key, activeModifier);
      if (!sequence) {
        return;
      }
      handleViewportInput(sequence);
      setActiveModifier(null);
      focusTerminalController();
    },
    [activeModifier, focusTerminalController, handleViewportInput],
  );

  const handleQuickKeyDown = React.useCallback(
    (event: KeyboardEvent) => {
      if (event.repeat) return;
      const rawKey = event.key;
      if (!rawKey || rawKey === 'Control' || rawKey === 'Meta' || rawKey === 'Alt' || rawKey === 'Shift') return;

      const normalizedKey = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
      if (normalizedKey in QUICK_KEY_MAP) {
        event.preventDefault();
        event.stopPropagation();
        handleMobileKeyPress(QUICK_KEY_MAP[normalizedKey]);
        return;
      }

      const controlCode = resolveTerminalControlKey(event, activeModifier);
      if (controlCode) {
        event.preventDefault();
        event.stopPropagation();
        handleViewportInput(controlCode);
        setActiveModifier(null);
        focusTerminalController();
      }
    },
    [activeModifier, focusTerminalController, handleMobileKeyPress, handleViewportInput],
  );

  React.useEffect(() => {
    if (!showQuickKeys || !activeModifier || !terminalSessionId) return;
    window.addEventListener('keydown', handleQuickKeyDown);
    return () => window.removeEventListener('keydown', handleQuickKeyDown);
  }, [activeModifier, handleQuickKeyDown, showQuickKeys, terminalSessionId]);

  return {
    activeModifier,
    setActiveModifier,
    terminalControllerRef,
    focusTerminalController,
    focusTerminalWhenWindowActive,
    handleViewportInput,
    handleViewportResize,
    handleModifierToggle,
    handleMobileKeyPress,
  };
}
