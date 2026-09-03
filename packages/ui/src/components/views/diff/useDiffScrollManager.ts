import React from 'react';
import { findDiffScrollAnchor, getRestoredDiffScrollTop, type DiffScrollAnchor } from '../diffScrollAnchor';
import { STACKED_DIFF_MOUNT_MARGIN } from './diffTurnUtils';
import type { FileEntry } from './diffTypes';

export function useDiffScrollManager({
  pinSelectedFileHeaderToTopOnNavigate,
  scrollRequestNonce,
  changedFiles,
  expandedFiles,
  setMountedStackedFiles,
  fileDiffRefreshNonce,
}: {
  pinSelectedFileHeaderToTopOnNavigate: boolean;
  scrollRequestNonce: number;
  changedFiles: FileEntry[];
  expandedFiles: Set<string>;
  setMountedStackedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  fileDiffRefreshNonce: Map<string, number>;
}) {
  const diffScrollRef = React.useRef<HTMLElement | null>(null);
  const fileSectionRefs = React.useRef(new Map<string, HTMLDivElement | null>());
  const [pinnedStackedTarget, setPinnedStackedTarget] = React.useState<string | null>(null);
  const pendingScrollTargetRef = React.useRef<string | null>(null);
  const pendingScrollFrameRef = React.useRef<number | null>(null);
  const shouldPinAfterAlignRef = React.useRef(false);
  const visibleSyncFrameRef = React.useRef<number | null>(null);
  const lastScrollAnchorRef = React.useRef<DiffScrollAnchor | null>(null);
  const pendingScrollAnchorRestoreRef = React.useRef<DiffScrollAnchor | null>(null);

  const captureScrollAnchor = React.useCallback((): DiffScrollAnchor | null => {
    const scrollRoot = diffScrollRef.current;
    if (!scrollRoot) return null;

    const rootTop = scrollRoot.getBoundingClientRect().top;
    const sections: Array<{ path: string; top: number }> = [];
    for (const [path, node] of fileSectionRefs.current) {
      if (node) sections.push({ path, top: node.getBoundingClientRect().top });
    }
    return findDiffScrollAnchor(rootTop, sections);
  }, []);

  const cancelPendingScrollAlignment = React.useCallback(() => {
    pendingScrollTargetRef.current = null;
    shouldPinAfterAlignRef.current = false;
    setPinnedStackedTarget(null);
    if (pendingScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingScrollFrameRef.current);
      pendingScrollFrameRef.current = null;
    }
  }, []);

  const syncVisibleStackedFiles = React.useCallback(() => {
    visibleSyncFrameRef.current = null;
    const scrollRoot = diffScrollRef.current;
    if (!scrollRoot) return;

    const rootRect = scrollRoot.getBoundingClientRect();
    const top = rootRect.top - STACKED_DIFF_MOUNT_MARGIN;
    const bottom = rootRect.bottom + STACKED_DIFF_MOUNT_MARGIN;
    const next: Record<string, boolean> = {};
    const sectionPositions: Array<{ path: string; top: number }> = [];

    for (const [path, node] of fileSectionRefs.current) {
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      sectionPositions.push({ path, top: rect.top });
      if (!expandedFiles.has(path)) continue;
      if (rect.bottom < top || rect.top > bottom) continue;
      next[path] = true;
    }
    lastScrollAnchorRef.current = findDiffScrollAnchor(rootRect.top, sectionPositions);

    setMountedStackedFiles((previous) => {
      let changed = false;
      const mounted = new Set(previous);
      for (const path of Object.keys(next)) {
        if (mounted.has(path)) continue;
        mounted.add(path);
        changed = true;
      }
      return changed ? mounted : previous;
    });
  }, [expandedFiles, setMountedStackedFiles]);

  const queueVisibleStackedFilesSync = React.useCallback(() => {
    if (typeof window === 'undefined') return;
    if (visibleSyncFrameRef.current !== null) return;
    visibleSyncFrameRef.current = window.requestAnimationFrame(syncVisibleStackedFiles);
  }, [syncVisibleStackedFiles]);

  React.useEffect(() => {
    const scrollRoot = diffScrollRef.current;
    if (!scrollRoot) return;

    queueVisibleStackedFilesSync();
    scrollRoot.addEventListener('scroll', queueVisibleStackedFilesSync, { passive: true });
    window.addEventListener('resize', queueVisibleStackedFilesSync);

    return () => {
      scrollRoot.removeEventListener('scroll', queueVisibleStackedFilesSync);
      window.removeEventListener('resize', queueVisibleStackedFilesSync);
      if (visibleSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(visibleSyncFrameRef.current);
        visibleSyncFrameRef.current = null;
      }
    };
  }, [changedFiles, expandedFiles, queueVisibleStackedFilesSync]);

  React.useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRestoreRef.current;
    if (!anchor) return;
    pendingScrollAnchorRestoreRef.current = null;

    const scrollRoot = diffScrollRef.current;
    const node = fileSectionRefs.current.get(anchor.path);
    if (!scrollRoot || !node) return;

    const rootTop = scrollRoot.getBoundingClientRect().top;
    const currentTopOffset = node.getBoundingClientRect().top - rootTop;
    scrollRoot.scrollTop = getRestoredDiffScrollTop(
      scrollRoot.scrollTop,
      anchor.topOffset,
      currentTopOffset,
      scrollRoot.scrollHeight - scrollRoot.clientHeight,
    );
    lastScrollAnchorRef.current = anchor;
  }, [fileDiffRefreshNonce]);

  const registerSectionRef = React.useCallback(
    (path: string, node: HTMLDivElement | null) => {
      const map = fileSectionRefs.current;
      if (node) {
        map.set(path, node);
      } else {
        map.delete(path);
      }
      queueVisibleStackedFilesSync();
    },
    [queueVisibleStackedFilesSync],
  );

  const scrollToFile = React.useCallback((path: string): boolean => {
    const node = fileSectionRefs.current.get(path);
    const scrollRoot = diffScrollRef.current;
    if (!node || !scrollRoot) {
      return false;
    }

    const scrollOffset = node.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
    scrollRoot.scrollTo({ top: scrollRoot.scrollTop + scrollOffset, behavior: 'auto' });
    return true;
  }, []);

  React.useEffect(() => {
    const target = pendingScrollTargetRef.current;
    if (!target) return;

    let attempts = 0;
    const maxAttempts = 20;
    let cancelled = false;

    const cancelPending = (clearPinnedTarget = true) => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      pendingScrollTargetRef.current = null;
      shouldPinAfterAlignRef.current = false;
      if (clearPinnedTarget) {
        setPinnedStackedTarget(null);
      }
      if (pendingScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingScrollFrameRef.current);
        pendingScrollFrameRef.current = null;
      }
    };

    const tryAlign = () => {
      if (cancelled) {
        pendingScrollFrameRef.current = null;
        return;
      }
      const currentTarget = pendingScrollTargetRef.current;
      if (!currentTarget) {
        cancelPending();
        pendingScrollFrameRef.current = null;
        return;
      }

      const result = scrollToFile(currentTarget);
      if (!result) {
        attempts += 1;
        if (attempts < maxAttempts) {
          pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);
        } else {
          cancelPending();
          pendingScrollFrameRef.current = null;
        }
        return;
      }

      if (pinSelectedFileHeaderToTopOnNavigate && shouldPinAfterAlignRef.current) {
        setPinnedStackedTarget(currentTarget);
        cancelPending(false);
        return;
      }
      cancelPending();
    };

    pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);

    return () => {
      cancelled = true;
      if (pendingScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingScrollFrameRef.current);
        pendingScrollFrameRef.current = null;
      }
    };
  }, [pinSelectedFileHeaderToTopOnNavigate, scrollRequestNonce, scrollToFile]);

  return {
    diffScrollRef,
    fileSectionRefs,
    pinnedStackedTarget,
    pendingScrollTargetRef,
    shouldPinAfterAlignRef,
    pendingScrollAnchorRestoreRef,
    lastScrollAnchorRef,
    captureScrollAnchor,
    cancelPendingScrollAlignment,
    queueVisibleStackedFilesSync,
    registerSectionRef,
    scrollToFile,
  };
}
