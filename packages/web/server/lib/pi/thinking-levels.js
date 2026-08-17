/** Pi thinking-level order and catalog rules. Keep in sync with `packages/ui/src/lib/pi/thinking.ts`. */

const PI_THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const isPiThinkingLevel = (value) => PI_THINKING_LEVELS.includes(value);

/**
 * Mirror of Pi `getSupportedThinkingLevels`.
 * `reasoning: false` → `['off']`. A `null` map entry hides that level.
 * `xhigh`/`max` are opt-in (must be present and non-null in the map).
 */
export const getSupportedThinkingLevels = (model) => {
  if (!model || model.reasoning !== true) return ['off'];
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
    ? model.thinkingLevelMap
    : undefined;
  const supported = PI_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
  return supported.length > 0 ? supported : ['off'];
};

/** If `requested` is missing, walk up the ordered list, then down. */
export const clampThinkingLevel = (supported, requested) => {
  const available = Array.isArray(supported) && supported.length > 0 ? supported : ['off'];
  if (requested && available.includes(requested)) return requested;
  const requestedIndex = PI_THINKING_LEVELS.indexOf(requested);
  if (requestedIndex === -1) return available[0];
  for (let index = requestedIndex + 1; index < PI_THINKING_LEVELS.length; index += 1) {
    if (available.includes(PI_THINKING_LEVELS[index])) return PI_THINKING_LEVELS[index];
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    if (available.includes(PI_THINKING_LEVELS[index])) return PI_THINKING_LEVELS[index];
  }
  return available[0];
};
