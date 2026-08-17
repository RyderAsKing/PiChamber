import { createReadStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Encode a resolved cwd the same way Pi's SessionManager names
 * `~/.pi/agent/sessions/<encoded-cwd>`. Drive letters and both slash styles
 * become hyphens so Windows `C:\Users\name\project` matches Pi CLI sessions.
 */
export const encodePiSessionCwd = (cwd) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

/**
 * Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a native Windows
 * path. Mirrors Pi's `normalizeWindowsShellPath` so a folder picked as
 * `/c/Users/name/project` still lands in the same session directory as Pi.
 */
export const normalizeWindowsShellPath = (filePath) => {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll('/', '\\');
  return `${match[1].toUpperCase()}:\\${suffix ?? ''}`;
};

class SessionJsonlError extends Error {
  constructor(code) {
    super('A Pi session JSONL file could not be read.');
    this.code = code;
  }
}

const malformed = () => new SessionJsonlError('MALFORMED_SESSION_JSONL');
const unreadable = () => new SessionJsonlError('SESSION_JSONL_UNREADABLE');

/**
 * Validates the JSONL files Pi discovers for a cwd before granting that
 * discovery result authority. Pi's discovery intentionally skips malformed
 * files; the daemon must instead surface them as an explicit failure.
 */
export async function validatePiSessionJsonlFile(filePath) {
  let sawHeader = false;
  try {
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw malformed();
      }
      if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw malformed();
      if (!sawHeader) {
        if (entry.type !== 'session' || typeof entry.id !== 'string' || entry.id.length === 0 || typeof entry.cwd !== 'string') {
          throw malformed();
        }
        sawHeader = true;
      }
    }
  } catch (error) {
    if (error instanceof SessionJsonlError) throw error;
    throw unreadable();
  }
  if (!sawHeader) throw malformed();
}

export const getPiSessionDirectory = ({
  cwd,
  agentDir,
  platform = process.platform,
  resolvePath = resolve,
} = {}) => {
  const normalizedCwd = platform === 'win32' ? normalizeWindowsShellPath(cwd) : cwd;
  return join(resolvePath(agentDir), 'sessions', encodePiSessionCwd(resolvePath(normalizedCwd)));
};

export async function validatePiSessionJsonlDirectory({ cwd, agentDir }) {
  let sessionDirectory;
  let entries;
  try {
    sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    entries = await readdir(sessionDirectory, { withFileTypes: true });
  } catch {
    throw unreadable();
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.jsonl')) continue;
    await validatePiSessionJsonlFile(join(sessionDirectory, entry.name));
  }
}
