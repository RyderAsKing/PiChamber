import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SessionNode } from './types';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';

export const ARCHIVED_VIRTUALIZE_THRESHOLD = 50;
export const ARCHIVED_ROW_ESTIMATE_PX = 28;

export interface VirtualArchivedSessionListProps {
  visibleSessions: SessionNode[];
  shouldVirtualize: boolean;
  hasExpandedParent: boolean;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  groupDirectory?: string | null;
  projectId?: string | null;
  isArchivedBucket: boolean;
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
    renderContext?: 'project' | 'recent',
    renderExtras?: SessionNodeRenderExtras
  ) => React.ReactNode;
  getRenderExtras: (node: SessionNode) => SessionNodeRenderExtras;
}

export function VirtualArchivedSessionList({
  visibleSessions,
  shouldVirtualize,
  hasExpandedParent,
  scrollContainerRef,
  groupDirectory,
  projectId,
  isArchivedBucket,
  renderSessionNode,
  getRenderExtras,
}: VirtualArchivedSessionListProps) {
  const archivedVirtualContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [archivedScrollEl, setArchivedScrollEl] = React.useState<HTMLElement | null>(null);
  const [archivedScrollMargin, setArchivedScrollMargin] = React.useState(0);

  const [, setLayoutVersion] = React.useState(0);
  React.useEffect(() => {
    if (!shouldVirtualize) return;
    const container = archivedVirtualContainerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setLayoutVersion((v) => v + 1));
    ro.observe(container);
    return () => ro.disconnect();
  }, [shouldVirtualize]);

  React.useLayoutEffect(() => {
    if (!shouldVirtualize) {
      if (archivedScrollEl !== null) setArchivedScrollEl(null);
      if (archivedScrollMargin !== 0) setArchivedScrollMargin(0);
      return;
    }
    const container = archivedVirtualContainerRef.current;
    if (!container) {
      return;
    }
    let scrollEl: HTMLElement | null = archivedScrollEl;
    const providedScrollEl = scrollContainerRef?.current ?? null;
    if (providedScrollEl && providedScrollEl.contains(container)) {
      scrollEl = providedScrollEl;
      if (scrollEl !== archivedScrollEl) {
        setArchivedScrollEl(scrollEl);
        return;
      }
    } else if (!scrollEl || !scrollEl.contains(container)) {
      let el: HTMLElement | null = container.parentElement;
      while (el) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollEl = el;
          break;
        }
        el = el.parentElement;
      }
      if (scrollEl !== archivedScrollEl) {
        setArchivedScrollEl(scrollEl);
        return;
      }
    }
    if (!scrollEl) return;
    const offset =
      container.getBoundingClientRect().top -
      scrollEl.getBoundingClientRect().top +
      scrollEl.scrollTop;
    setArchivedScrollMargin((prev) => (Math.abs(prev - offset) < 1 ? prev : offset));
  });

  const virtualizerReady = shouldVirtualize && archivedScrollEl !== null;
  const sessionVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: visibleSessions.length,
    enabled: virtualizerReady,
    getScrollElement: () => archivedScrollEl,
    initialOffset: () => archivedScrollEl?.scrollTop ?? 0,
    estimateSize: () => ARCHIVED_ROW_ESTIMATE_PX,
    overscan: hasExpandedParent ? 20 : 8,
    scrollMargin: archivedScrollMargin,
    getItemKey: (index) => visibleSessions[index]?.session.id ?? index,
  });

  return (
    <div ref={archivedVirtualContainerRef}>
      {!shouldVirtualize ? (
        visibleSessions.map((node) => (
          <React.Fragment key={node.session.id}>
            {renderSessionNode(
              node,
              0,
              groupDirectory,
              projectId,
              isArchivedBucket,
              undefined,
              'project',
              getRenderExtras(node)
            )}
          </React.Fragment>
        ))
      ) : (
        <div style={{ height: sessionVirtualizer.getTotalSize(), position: 'relative' }}>
          {sessionVirtualizer.getVirtualItems().map((item) => {
            const node = visibleSessions[item.index];
            if (!node) return null;
            return (
              <div
                key={node.session.id}
                data-index={item.index}
                ref={sessionVirtualizer.measureElement}
                className="[&_[data-session-row]]:my-px"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start - archivedScrollMargin}px)`,
                }}
              >
                {renderSessionNode(
                  node,
                  0,
                  groupDirectory,
                  projectId,
                  isArchivedBucket,
                  undefined,
                  'project',
                  getRenderExtras(node)
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
