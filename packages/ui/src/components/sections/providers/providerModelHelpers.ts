import type { PiProvider, PiThinkingLevel } from '@/lib/pi/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const providerScope = () => ({ runtimeKey: getRuntimeKey() });

export const FALLBACK_THINKING = '__pi_fallback__';

export const thinkingSelectOptions = (
  levels: PiThinkingLevel[],
  stored?: PiThinkingLevel,
): PiThinkingLevel[] => {
  const options = [...levels];
  if (stored && !options.includes(stored)) options.push(stored);
  return options;
};

export const sortProviders = (providers: readonly PiProvider[]): PiProvider[] => {
  return [...providers].sort((a, b) => {
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
};
