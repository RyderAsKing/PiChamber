import React from 'react';

import { SidebarFilesTree } from '../SidebarFilesTree';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

const EDITOR_TREE_MIN_WIDTH = 200;
const EDITOR_TREE_MAX_WIDTH = 480;
/** The editor keeps at least this much of the panel; the tree gives way first. */
const EDITOR_MIN_WIDTH = 280;
/** How narrow the tree may get while giving way to the editor. */
const EDITOR_TREE_FIT_MIN_WIDTH = 160;

// The editor surface's file-tree column: docked on the right, resizable from
// its left edge, and animated open/closed like the app sidebars. In a panel
// too narrow to share with an open file, `overlay` lays it over the editor's
// right edge instead, so the file keeps its full width underneath.
export const EditorTreeColumn: React.FC<{ visible: boolean; overlay?: boolean }> = ({ visible, overlay = false }) => {
  const width = useUIStore((state) => state.contextEditorTreeWidth);
  const setWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);

  const clampTreeWidth = React.useCallback((value: number) => {
    return Math.min(EDITOR_TREE_MAX_WIDTH, Math.max(EDITOR_TREE_MIN_WIDTH, Math.round(value)));
  }, []);

  // The width of the row the tree shares with the editor; null until measured
  // or while the row is hidden.
  const [rowWidth, setRowWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const row = columnRef.current?.parentElement;
    if (!row) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      setRowWidth(next > 0 ? Math.round(next) : null);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  // The stored width is a preference; in a narrow panel the tree shrinks so the
  // file stays readable, and grows back when the panel widens.
  const fitTreeWidth = React.useCallback((value: number) => {
    if (rowWidth === null) return value;
    // Over the editor the tree may take most of the row: the file is behind it.
    if (overlay) return Math.max(EDITOR_TREE_FIT_MIN_WIDTH, Math.min(value, rowWidth - 48));
    return Math.max(EDITOR_TREE_FIT_MIN_WIDTH, Math.min(value, rowWidth - EDITOR_MIN_WIDTH));
  }, [overlay, rowWidth]);
  const fittedWidth = fitTreeWidth(width);

  const applyLiveTreeWidth = React.useCallback((nextWidth: number) => {
    const column = columnRef.current;
    if (!column) {
      return;
    }
    column.style.width = `${nextWidth}px`;
    column.style.setProperty('--oc-editor-tree-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!visible) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = fittedWidth;
    liveWidthRef.current = fittedWidth;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || pointerIDRef.current !== event.pointerId) {
      return;
    }
    const delta = startXRef.current - event.clientX;
    const nextWidth = fitTreeWidth(clampTreeWidth(startWidthRef.current + delta));
    if (liveWidthRef.current === nextWidth) {
      return;
    }
    liveWidthRef.current = nextWidth;
    applyLiveTreeWidth(nextWidth);
  };

  const handlePointerEnd = (event: React.PointerEvent) => {
    if (pointerIDRef.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampTreeWidth(liveWidthRef.current ?? width);
    pointerIDRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
  };

  const appliedWidth = visible ? fittedWidth : 0;

  return (
    <div
      ref={columnRef}
      className={cn(
        'h-full flex-shrink-0 overflow-hidden border-l border-border bg-background will-change-[width] motion-reduce:transition-none',
        overlay ? 'absolute inset-y-0 right-0 z-20' : 'relative',
        !visible && 'border-l-0',
      )}
      style={{
        width: `${isResizing ? (liveWidthRef.current ?? appliedWidth) : appliedWidth}px`,
        ['--oc-editor-tree-width' as string]: `${isResizing ? (liveWidthRef.current ?? fittedWidth) : fittedWidth}px`,
        overflowX: 'clip',
        transitionProperty: isResizing ? 'none' : 'width',
        transitionDuration: '200ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-hidden={!visible}
    >
      {visible && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={"Resize context panel"}
        />
      )}
      <div
        className={cn(
          'relative z-10 h-full shrink-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          isResizing && 'pointer-events-none',
          !visible && 'pointer-events-none select-none opacity-0'
        )}
        style={{ width: 'var(--oc-editor-tree-width)' }}
        aria-hidden={!visible}
      >
        <SidebarFilesTree />
      </div>
    </div>
  );
};
