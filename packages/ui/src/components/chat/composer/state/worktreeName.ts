import { runtimeFetch } from '@/lib/runtime-fetch';

const MAX_WORKTREE_NAME_LENGTH = 48;

export const normalizeWorktreeName = (value: string): string => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, MAX_WORKTREE_NAME_LENGTH)
  .replace(/-$/g, '');

const readGeneratedWorktreeName = (value: string): string | null => {
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_WORKTREE_NAME_LENGTH) return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) ? candidate : null;
};

export const deriveLocalWorktreeName = (prompt: string): string | null => {
  const normalized = normalizeWorktreeName(prompt.trim());
  if (!normalized) return null;
  const words = normalized.split('-').filter(Boolean).slice(0, 7);
  const result = words.join('-').slice(0, MAX_WORKTREE_NAME_LENGTH).replace(/-$/g, '');
  return result || null;
};

export const deriveWorktreeName = async (prompt: string, directory: string): Promise<string | null> => {
  const trimmed = prompt.trim();
  if (!trimmed || !directory) return deriveLocalWorktreeName(trimmed);
  try {
    const response = await runtimeFetch('/api/pi/small-model/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: trimmed, directory }),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null) as { text?: unknown } | null;
      if (typeof payload?.text === 'string') {
        const generated = readGeneratedWorktreeName(payload.text);
        if (generated) return generated;
      }
    }
  } catch {
    // Naming is convenience only. Worktree creation has deterministic and
    // server-generated fallbacks and must not fail with the model request.
  }
  return deriveLocalWorktreeName(trimmed);
};
