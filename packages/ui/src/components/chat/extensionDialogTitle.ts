import { stripAnsi } from '@/lib/pi/ansi';

/**
 * Pi dialogs carry one `title`. Extensions often pack a whole request into it
 * (a heading line, then the details), so a multi-line title splits into a
 * short label and the text below it. A one-line title has no label: it is the
 * question itself.
 */
interface DialogTitleParts {
  label: string | null;
  text: string;
}

const isBlank = (line: string): boolean => stripAnsi(line).trim().length === 0;

export const splitDialogTitle = (title: string): DialogTitleParts => {
  const lines = title.split(/\r\n|\r|\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? '')) start += 1;
  while (end > start && isBlank(lines[end - 1] ?? '')) end -= 1;
  if (end - start <= 1) return { label: null, text: (lines[start] ?? '').trim() };

  const label = (lines[start] ?? '').trim();
  let textStart = start + 1;
  while (textStart < end && isBlank(lines[textStart] ?? '')) textStart += 1;
  return { label, text: lines.slice(textStart, end).join('\n') };
};

/** One line of plain text for a collapsed header. */
export const firstPlainLine = (text: string): string =>
  stripAnsi(text).split(/\r\n|\r|\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
