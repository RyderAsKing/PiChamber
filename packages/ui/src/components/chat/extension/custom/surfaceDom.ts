import { stripAnsi } from '@/lib/pi/ansi';

export const surfaceSelector = (surfaceId: string): string => `[data-extension-surface="${CSS.escape(surfaceId)}"]`;

export const focusSurfaceElement = (surfaceId: string): void => {
  document.querySelector<HTMLElement>(surfaceSelector(surfaceId))?.focus({ preventScroll: true });
};

/** The frame as plain text: colours dropped, trailing spaces and blank lines trimmed. */
export const surfaceFrameText = (lines: readonly string[]): string => {
  const plain = lines.map((line) => stripAnsi(line).trimEnd());
  while (plain.length > 0 && plain[plain.length - 1] === '') plain.pop();
  return plain.join('\n');
};
