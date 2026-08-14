/**
 * Derives a clean, concise title from the initial prompt text of a session.
 * Pure deterministic transformation without network calls or heuristics.
 */
export function deriveSessionTitle(promptText: string, maxLength = 50): string {
  if (typeof promptText !== 'string' || promptText.trim().length === 0) {
    return '';
  }

  const cleaned = promptText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\[attachment:[^\]]+\]/g, ' ')
    .replace(/(^|\s)@[\w.-]+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n');

  const firstLine = cleaned
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return '';

  const singleSpaced = firstLine.replace(/\s+/g, ' ');
  if (singleSpaced.length <= maxLength) {
    return singleSpaced;
  }

  return `${singleSpaced.slice(0, maxLength).trimEnd()}…`;
}
