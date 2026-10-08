import i18n from '@/i18n';

/**
 * Session display-title fallback.
 *
 * A session with no title and an authoritatively empty transcript (for
 * example after an extension slash command configured the backend without
 * starting the conversation) reads as awaiting its first prompt rather than
 * untitled. Any other untitled session keeps the caller's fallback so
 * unknown message counts never infer emptiness.
 */

export const AWAITING_FIRST_PROMPT_LABEL = 'Awaiting first prompt';

export function getSessionDisplayTitle(
  session: { title?: string | null; messageCount?: number | null } | null | undefined,
  fallback: string = i18n.t('Untitled Session'),
): string {
  const title = session?.title?.trim();
  if (title) return title;
  if (session?.messageCount === 0) return i18n.t(AWAITING_FIRST_PROMPT_LABEL);
  return fallback;
}
