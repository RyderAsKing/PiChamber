import { normalizePath } from '@/lib/pathNormalization';
import type { Session } from '@/lib/chat/types';

export type SessionDirectoryResolution = {
  directory: string | null;
  source?: string;
};

export type SessionDirectorySources = {
  session?: Session | null;
  currentDirectory?: string | null;
};

export function resolveSessionDirectoryFromSources(sources: SessionDirectorySources): SessionDirectoryResolution {
  const directory = normalizePath(
    (sources.session as Session & { directory?: string | null })?.directory
      ?? sources.currentDirectory
      ?? null,
  );
  return { directory, source: directory ? 'session' : undefined };
}

export function describeSessionDirectorySources(_sources?: SessionDirectorySources): string {
  return '';
}
