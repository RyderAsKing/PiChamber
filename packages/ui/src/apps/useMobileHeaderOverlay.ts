import React from 'react';

import { useTabletLayout } from '@/lib/device';

export const MOBILE_HEADER_POPOVER_WIDTH = 380;
const MOBILE_HEADER_POPOVER_MARGIN = 8;
const MOBILE_HEADER_OVERLAY_EXIT_MS = 140;

type MobileHeaderOverlayOptions = {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  closeOnWheel?: boolean;
};

export function useMobileHeaderOverlay({
  open,
  onClose,
  anchorRef,
  closeOnWheel = false,
}: MobileHeaderOverlayOptions) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);
  const [anchorLeft, setAnchorLeft] = React.useState<number | null>(null);
  const { enabled: isTabletLayout } = useTabletLayout();

  React.useLayoutEffect(() => {
    if (!open || !isTabletLayout || !shouldRender) return;
    const compute = () => {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (!anchorRect || !wrapperRect) {
        setAnchorLeft(null);
        return;
      }
      const relativeLeft = anchorRect.left - wrapperRect.left;
      setAnchorLeft(Math.min(
        Math.max(relativeLeft, MOBILE_HEADER_POPOVER_MARGIN),
        Math.max(
          MOBILE_HEADER_POPOVER_MARGIN,
          wrapperRect.width - MOBILE_HEADER_POPOVER_WIDTH - MOBILE_HEADER_POPOVER_MARGIN,
        ),
      ));
    };
    compute();
    const wrapper = wrapperRef.current;
    if (typeof ResizeObserver === 'undefined' || !wrapper) return;
    const observer = new ResizeObserver(compute);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [anchorRef, isTabletLayout, open, shouldRender]);

  React.useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsExiting(false);
      return;
    }
    if (!shouldRender) return;
    setIsExiting(true);
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
      setIsExiting(false);
    }, MOBILE_HEADER_OVERLAY_EXIT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [open, shouldRender]);

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  React.useEffect(() => {
    if (!open) return;
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        onClose();
        return;
      }
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', closeIfOutside, true);
    if (closeOnWheel) document.addEventListener('wheel', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
      if (closeOnWheel) document.removeEventListener('wheel', closeIfOutside, true);
    };
  }, [anchorRef, closeOnWheel, onClose, open]);

  return {
    panelRef,
    wrapperRef,
    shouldRender,
    isExiting,
    anchorLeft,
    isPopover: isTabletLayout && anchorLeft !== null,
  };
}
