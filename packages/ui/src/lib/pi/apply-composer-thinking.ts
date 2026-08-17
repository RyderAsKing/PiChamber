import { getPiSessionStore } from '@/apps/pi-session-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { cycleThinkingLevel, isPiThinkingLevel } from '@/lib/pi/thinking';
import type { PiThinkingLevel } from '@/lib/pi/types';

export type ApplyComposerThinkingHost = {
  getCurrentVariant: () => string | undefined;
  setCurrentVariant: (variant: string | undefined) => void;
  getSessionId: () => string | null | undefined;
  setSessionThinking: (sessionId: string, thinking: PiThinkingLevel) => Promise<void>;
};

const defaultHost = (): ApplyComposerThinkingHost => ({
  getCurrentVariant: () => useConfigStore.getState().currentVariant,
  setCurrentVariant: (variant) => useConfigStore.getState().setCurrentVariant(variant),
  getSessionId: () => useSessionUIStore.getState().currentSessionId,
  setSessionThinking: (sessionId, thinking) => getPiSessionStore().setThinking(sessionId, thinking),
});

let applyGeneration = 0;

/**
 * Set the composer thinking override. When a session is open and `level` is an
 * explicit Pi thinking level, apply it live via `sessions.setThinking`.
 * Unset/Default only clears the composer override; it does not invent a level.
 * A failed live write rolls back the composer value unless a newer apply owns it.
 */
export const applyComposerThinking = async (
  level: PiThinkingLevel | undefined,
  host: ApplyComposerThinkingHost = defaultHost(),
): Promise<'applied' | 'superseded'> => {
  const generation = ++applyGeneration;
  const previous = host.getCurrentVariant();
  host.setCurrentVariant(level);

  const sessionId = host.getSessionId();
  if (!sessionId || !isPiThinkingLevel(level)) {
    return generation === applyGeneration ? 'applied' : 'superseded';
  }

  try {
    await host.setSessionThinking(sessionId, level);
    return generation === applyGeneration ? 'applied' : 'superseded';
  } catch (error) {
    if (generation !== applyGeneration) return 'superseded';
    if (host.getCurrentVariant() === level) {
      host.setCurrentVariant(previous);
    }
    throw error;
  }
};

export const cycleComposerThinking = async (
  direction: 1 | -1 = 1,
): Promise<PiThinkingLevel | undefined> => {
  const config = useConfigStore.getState();
  const next = cycleThinkingLevel(config.getCurrentModelVariants(), config.currentVariant, direction);
  await applyComposerThinking(next);
  return next;
};
