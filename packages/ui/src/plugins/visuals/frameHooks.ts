import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { buildVisualDocument, readVisualTheme } from './document';

/** Mount the frame a little before it scrolls into view. */
const MOUNT_MARGIN = '600px 0px';

/** The sandboxed document for a page, rebuilt when the theme changes. */
export function usePageDocument(html: string, allowNetwork: boolean): string {
  const { currentTheme } = useThemeSystem();
  const variant = currentTheme.metadata.variant;
  const themeId = currentTheme.metadata.id;
  return React.useMemo(() => {
    // Read after the theme's CSS variables are applied for `themeId`.
    void themeId;
    const theme = readVisualTheme(document.documentElement, variant);
    return buildVisualDocument({ html, theme, allowNetwork });
  }, [allowNetwork, html, themeId, variant]);
}

/** True once `hostRef` has come near the viewport; frames mount then, not before. */
export function useNearViewport(hostRef: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = React.useState(false);
  React.useEffect(() => {
    const host = hostRef.current;
    if (near || !host) return;
    if (typeof IntersectionObserver !== 'function') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: MOUNT_MARGIN });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef, near]);
  return near;
}
