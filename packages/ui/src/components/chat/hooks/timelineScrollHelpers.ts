import type { ChatMessageEntry } from '../lib/turns/types';
import type { TurnWindowModel } from '../lib/turns/windowTurns';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

export type ViewportAnchor = { messageId: string; offsetTop: number };
export type TimelineIdentityToken = { key: string | null };

export type PendingScrollRequest = {
  identity: TimelineIdentityToken;
  kind: 'turn' | 'message';
  id: string;
  behavior: ScrollBehavior;
  turnId: string | null;
  resolve: (value: boolean) => void;
};

export const TURN_MODEL_CACHE_MAX = 30;
export const HISTORY_SCROLL_THRESHOLD_MIN_PX = 1200;
export const HISTORY_SCROLL_VIEWPORT_FACTOR = 1.5;

export const resolveHistoryScrollThreshold = (clientHeight: number): number => Math.max(
  HISTORY_SCROLL_THRESHOLD_MIN_PX,
  clientHeight * HISTORY_SCROLL_VIEWPORT_FACTOR,
);

export const MOBILE_TURN_MODEL_CACHE_MAX = 4;
export const MOBILE_TURN_MODEL_CACHE_MAX_MESSAGES = 30;
export const HISTORY_RENDER_WAIT_TIMEOUT_MS = 250;
export const HISTORY_INTERACTION_GUARD_MS = 2000;
export const SCROLL_PIN_TIMEOUT_MS = 2500;

export const turnModelCache = new Map<string, { messages: ChatMessageEntry[]; model: TurnWindowModel }>();

export const getTurnModelCacheMax = () => {
  if (isMobileSurfaceRuntime()) return MOBILE_TURN_MODEL_CACHE_MAX;
  return TURN_MODEL_CACHE_MAX;
};

export const shouldCacheTurnModelMessages = (messages: ChatMessageEntry[]): boolean => {
  if (isMobileSurfaceRuntime()) return messages.length <= MOBILE_TURN_MODEL_CACHE_MAX_MESSAGES;
  return true;
};

export const rememberTurnModel = (key: string, value: { messages: ChatMessageEntry[]; model: TurnWindowModel }) => {
  turnModelCache.delete(key);
  if (!shouldCacheTurnModelMessages(value.messages)) {
    return;
  }
  const max = getTurnModelCacheMax();
  while (turnModelCache.size >= max) {
    const oldest = turnModelCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    turnModelCache.delete(oldest);
  }
  turnModelCache.set(key, value);
};

export const shouldAutoLoadEarlierForUnderfilledPinnedViewport = (input: {
  sessionId: string | null;
  isPinned: boolean;
  canLoadEarlier: boolean;
  isLoadingOlder: boolean;
  pendingRevealWork: boolean;
  scrollHeight: number;
  clientHeight: number;
}): boolean => {
  if (!input.sessionId) return false;
  if (!input.isPinned || !input.canLoadEarlier) return false;
  if (input.isLoadingOlder || input.pendingRevealWork) return false;
  return input.scrollHeight <= input.clientHeight + 1;
};

export const isOlderHistoryPrependCommit = (input: {
  previousOldestId: string | null;
  previousNewestId: string | null;
  currentOldestId: string | null;
  currentNewestId: string | null;
}): boolean => Boolean(
  input.previousOldestId
  && input.currentOldestId
  && input.currentOldestId !== input.previousOldestId
  && input.previousNewestId
  && input.currentNewestId
  && input.currentNewestId === input.previousNewestId,
);

export const MOMENTUM_WATCHDOG_FRAMES = 20;
export const MOMENTUM_WATCHDOG_TOLERANCE_PX = 4;

export const setScrollTopDefeatingMomentum = (container: HTMLElement, target: number) => {
  const previousOverflow = container.style.overflow;
  container.style.overflow = 'hidden';
  container.scrollTop = target;
  void container.scrollHeight;
  container.style.overflow = previousOverflow;
  container.scrollTop = target;

  if (typeof window === 'undefined') return;
  let cancelled = false;
  let frames = 0;
  const cancelOnUserTouch = () => {
    cancelled = true;
  };
  container.addEventListener('touchstart', cancelOnUserTouch, { passive: true, once: true });
  const watch = () => {
    if (cancelled) return;
    if (container.scrollTop < target - MOMENTUM_WATCHDOG_TOLERANCE_PX) {
      container.scrollTop = target;
    }
    frames += 1;
    if (frames < MOMENTUM_WATCHDOG_FRAMES) {
      window.requestAnimationFrame(watch);
    } else {
      container.removeEventListener('touchstart', cancelOnUserTouch);
    }
  };
  window.requestAnimationFrame(watch);
};

export const hasInsertedBeforeKnownOldest = (
  previousOldestId: string | null,
  currentOldestId: string | null,
  messages: ChatMessageEntry[],
): boolean => {
  if (!previousOldestId || !currentOldestId || currentOldestId === previousOldestId) {
    return false;
  }

  return messages.some((message) => message.info.id === previousOldestId);
};
