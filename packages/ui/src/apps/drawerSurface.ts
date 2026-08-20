import type { RefObject } from 'react';

import { MOBILE_DRAWER_EASING, MOBILE_DRAWER_DURATION_MS } from './useDrawerSwipe';

/**
 * Small adapter that owns imperative drawer surface mutations.
 * MobileApp stays responsible for open state; drag callbacks only write
 * compositor-friendly styles through these refs.
 */
type PhoneDrawerRefs = {
  drawer: RefObject<HTMLElement | null>;
  scrim: RefObject<HTMLElement | null>;
  root: RefObject<HTMLElement | null>;
};

export const beginPhoneDrawerDrag = (refs: PhoneDrawerRefs): void => {
  const drawer = refs.drawer.current;
  const scrim = refs.scrim.current;
  const root = refs.root.current;
  if (root) {
    root.style.pointerEvents = 'auto';
    root.style.visibility = 'visible';
  }
  if (drawer) drawer.style.transition = 'none';
  if (scrim) scrim.style.transition = 'none';
};

export const applyPhoneDrawerProgress = (
  refs: PhoneDrawerRefs,
  side: 'left' | 'right',
  progress: number,
): void => {
  const drawer = refs.drawer.current;
  const scrim = refs.scrim.current;
  if (drawer) {
    drawer.style.transform = progress >= 0.999
      ? 'none'
      : `translateX(${(side === 'left' ? progress - 1 : 1 - progress) * 100}%)`;
  }
  if (scrim) {
    scrim.style.opacity = String(progress);
    const pointerEvents = progress > 0.01 ? 'auto' : 'none';
    if (scrim.style.pointerEvents !== pointerEvents) {
      scrim.style.pointerEvents = pointerEvents;
    }
  }
};

export const settlePhoneDrawerViaRefs = (
  side: 'left' | 'right',
  shouldOpen: boolean,
  refs: PhoneDrawerRefs,
): void => {
  const drawer = refs.drawer.current;
  const scrim = refs.scrim.current;
  const root = refs.root.current;
  if (drawer) {
    drawer.style.transition = `transform ${MOBILE_DRAWER_DURATION_MS}ms ${MOBILE_DRAWER_EASING}`;
    drawer.style.transform = shouldOpen
      ? 'none'
      : side === 'left' ? 'translateX(-100%)' : 'translateX(100%)';
  }
  if (scrim) {
    scrim.style.transition = `opacity ${MOBILE_DRAWER_DURATION_MS}ms ${MOBILE_DRAWER_EASING}`;
    scrim.style.opacity = shouldOpen ? '1' : '0';
    scrim.style.pointerEvents = shouldOpen ? 'auto' : 'none';
  }
  if (root) {
    root.style.pointerEvents = shouldOpen ? 'auto' : 'none';
    root.style.visibility = shouldOpen ? 'visible' : '';
  }
};

/**
 * Tablet two-layer panel surface.
 * The outer shell owns layout width; the fixed-width inner surface translates.
 * Keeping width transitions out of the shell avoids reflowing chat on every
 * animation frame.
 */
type TabletPanelRefs = {
  shell: RefObject<HTMLElement | null>;
  inner: RefObject<HTMLElement | null>;
};

export const beginTabletPanelDrag = (refs: TabletPanelRefs): void => {
  const shell = refs.shell.current;
  const inner = refs.inner.current;
  if (shell) shell.style.overflow = 'visible';
  if (inner) inner.style.transition = 'none';
};

export const applyTabletPanelProgress = (
  refs: TabletPanelRefs,
  progress: number,
  width: number,
  side: 'left' | 'right',
): void => {
  const inner = refs.inner.current;
  if (!inner) return;
  const x = side === 'left' ? (progress - 1) * width : (1 - progress) * width;
  inner.style.transform = progress >= 0.999 ? 'translateX(0)' : `translateX(${x}px)`;
};

export const settleTabletPanel = (
  refs: TabletPanelRefs,
  shouldOpen: boolean,
  width: number,
  side: 'left' | 'right',
  onDone?: () => void,
): number | undefined => {
  const shell = refs.shell.current;
  const inner = refs.inner.current;
  if (!shell || !inner) return undefined;

  inner.style.transition = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';
  inner.style.transform = shouldOpen
    ? 'translateX(0)'
    : `translateX(${side === 'left' ? -width : width}px)`;

  const timeoutId = window.setTimeout(() => {
    inner.style.transition = '';
    inner.style.transform = '';
    shell.style.overflow = '';
    onDone?.();
  }, 220);
  return timeoutId;
};
