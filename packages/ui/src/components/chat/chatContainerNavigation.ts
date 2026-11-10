import type { Message, Part } from '@/lib/chat/types';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

export const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
export const IDLE_SESSION_STATUS = { type: 'idle' as const };
export const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'pichamber:chat-force-scroll-bottom';
export const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';
export const CHAT_SCROLL_STYLE = {
  overflowAnchor: 'none',
  overscrollBehavior: 'contain',
  overscrollBehaviorY: 'contain',
  // A short top fade: the default 48px washed out the row just below the header.
  '--scroll-shadow-top-size': '16px',
} as const;

/**
 * The composer bar sits above the timeline (z-10), except while a custom()
 * overlay dims the pane: its z-index would then trap the extension prompt
 * dock under the overlay layer, and the dim covers the timeline anyway.
 */
export const composerLayerClassName = (overlayDims: boolean) => (overlayDims ? 'relative' : 'relative z-10');

export const composerBarClassName = (expanded: boolean, overlayDims = false) =>
  cn(
    composerLayerClassName(overlayDims),
    'flex flex-col gap-2 bg-background',
    expanded ? 'flex-1 min-h-0' : 'shrink-0'
  );

export const CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="combobox"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="textbox"]',
  '[data-radix-popper-content-wrapper]',
].join(',');

export type SessionMessageRecord = { info: Message; parts: Part[] };

export const isHTMLElement = (target: EventTarget | null): target is HTMLElement => {
  return target instanceof HTMLElement;
};

export const shouldIgnoreChatNavigationTarget = (target: EventTarget | null): boolean => {
  if (!isHTMLElement(target)) {
    return false;
  }

  return Boolean(target.closest(CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR));
};

export const shouldIgnoreChatNavigationForFocus = (
  activeElement: Element | null,
  scrollContainer: HTMLElement | null
): boolean => {
  if (typeof document === 'undefined') {
    return true;
  }

  if (
    !activeElement ||
    activeElement === document.body ||
    activeElement === document.documentElement
  ) {
    return true;
  }

  if (shouldIgnoreChatNavigationTarget(activeElement)) {
    return true;
  }

  return !scrollContainer?.contains(activeElement);
};

export const hasBlockingChatOverlay = (): boolean => {
  const {
    isCommandPaletteOpen,
    isHelpDialogOpen,
    isImagePreviewOpen,
    isSessionSwitcherOpen,
    isSettingsDialogOpen,
  } = useUIStore.getState();

  return (
    isCommandPaletteOpen ||
    isHelpDialogOpen ||
    isImagePreviewOpen ||
    isSessionSwitcherOpen ||
    isSettingsDialogOpen
  );
};
