import { useConfigStore } from '@/stores/useConfigStore';
import { cycleThinkingLevel } from '@/lib/pi/thinking';
import type { PiThinkingLevel } from '@/lib/pi/types';

export type ApplyComposerThinkingHost = {
  setCurrentVariant: (variant: string | undefined) => void;
};

const defaultHost = (): ApplyComposerThinkingHost => ({
  setCurrentVariant: (variant) => useConfigStore.getState().setCurrentVariant(variant),
});

/**
 * Set the composer thinking override only. The open Pi session is updated on
 * send (`routeMessage`), the same way model picks stay local until prompt.
 * Unset/Default clears the composer override; it does not invent a level.
 */
export const applyComposerThinking = (
  level: PiThinkingLevel | undefined,
  host: ApplyComposerThinkingHost = defaultHost(),
): 'applied' => {
  host.setCurrentVariant(level);
  return 'applied';
};

export const cycleComposerThinking = async (
  direction: 1 | -1 = 1,
): Promise<PiThinkingLevel | undefined> => {
  const config = useConfigStore.getState();
  const next = cycleThinkingLevel(config.getCurrentModelVariants(), config.currentVariant, direction);
  applyComposerThinking(next);
  return next;
};
