import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
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

/** Stop looking for the first user prompt after this many leading bytes. */
const LIST_HEAD_SCAN_BYTES = 512 * 1024;
/** Latest `session_info` (rename) is appended; read a tail instead of the whole log. */
const LIST_TAIL_SCAN_BYTES = 128 * 1024;
const LIST_PREVIEW_CHARS = 500;
/** Bound in-directory JSONL listing so a large folder is not one file at a time. */
const LIST_FILE_CONCURRENCY = 8;

const mapWithConcurrency = async (values, concurrency, mapper) => {
  if (values.length === 0) return [];
  const safeConcurrency = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const nextIndex = cursor;
      cursor += 1;
      if (nextIndex >= values.length) return;
      results[nextIndex] = await mapper(values[nextIndex]);
    }
  };
  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
};

const isSessionHeader = (entry) => (
  Boolean(entry)
  && !Array.isArray(entry)
  && typeof entry === 'object'
  && entry.type === 'session'
  && typeof entry.id === 'string'
  && entry.id.length > 0
  && typeof entry.cwd === 'string'
);

const extractUserPreview = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .trim();
};

const trimPreview = (text) => {
  if (!text) return undefined;
  return text.length > LIST_PREVIEW_CHARS ? text.slice(0, LIST_PREVIEW_CHARS) : text;
};

const sessionInfoName = (entry) => {
  if (!entry || entry.type !== 'session_info') return undefined;
  if (typeof entry.name !== 'string') return undefined;
  const name = entry.name.trim();
  return name.length > 0 ? name : undefined;
};

/**
 * Validates the JSONL files Pi discovers for a cwd before granting that
 * discovery result authority. Pi's discovery intentionally skips malformed
 * files; the daemon must instead surface them as an explicit failure.
 * List/startup/create only require a valid session header. Full-file
 * validation stays on open of a chosen transcript so a 16MB log cannot
 * block every `sessions.list`.
 */
export const matchesPiSessionJsonlName = (fileName, sessionId) => (
  typeof fileName === 'string'
  && typeof sessionId === 'string'
  && sessionId.length > 0
  && fileName.endsWith('.jsonl')
  && (fileName === `${sessionId}.jsonl` || fileName.endsWith(`_${sessionId}.jsonl`))
);

/**
 * Read only the session header. Callers that are looking up an id must
 * not scan the rest of a multi-megabyte transcript.
 */
async function readPiSessionJsonlHeader(filePath) {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw malformed();
      }
      if (!isSessionHeader(entry)) throw malformed();
      return entry;
    }
    throw malformed();
  } catch (error) {
    if (error instanceof SessionJsonlError) throw error;
    throw unreadable();
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Locate a persisted Pi session by the SDK filename (`<timestamp>_<id>.jsonl`
 * or `<id>.jsonl`) without listing or fully reading every transcript. A miss
 * is `null`, not an empty success.
 */
export async function findPiSessionJsonlById({ sessionId, agentDir, resolvePath = resolve }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof agentDir !== 'string') {
    return null;
  }
  const sessionsRoot = join(resolvePath(agentDir), 'sessions');
  let dirEntries;
  try {
    dirEntries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) continue;
    const dirPath = join(sessionsRoot, dirEntry.name);
    let files;
    try {
      files = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.isDirectory()) continue;
      if (!matchesPiSessionJsonlName(file.name, sessionId)) continue;
      const fullPath = join(dirPath, file.name);
      try {
        const header = await readPiSessionJsonlHeader(fullPath);
        if (header.id === sessionId) {
          return { id: sessionId, path: fullPath, cwd: header.cwd };
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

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
        if (!isSessionHeader(entry)) throw malformed();
        sawHeader = true;
      }
    }
  } catch (error) {
    if (error instanceof SessionJsonlError) throw error;
    throw unreadable();
  }
  if (!sawHeader) throw malformed();
}

async function readLatestSessionInfoFromTail(filePath, fileSize) {
  const tailSize = Math.min(fileSize, LIST_TAIL_SCAN_BYTES);
  if (tailSize <= 0) return null;
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(tailSize);
    const { bytesRead } = await handle.read(buffer, 0, tailSize, fileSize - tailSize);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    let seen = false;
    let name;
    for (const line of lines.slice(fileSize > tailSize ? 1 : 0)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === 'session_info') {
          seen = true;
          name = sessionInfoName(entry);
        }
      } catch {
        continue;
      }
    }
    return seen ? { name } : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readPiSessionJsonlListFields(filePath, fileSize) {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header;
  let name;
  let firstMessage;
  let bytes = 0;
  const scanWholePrefix = fileSize <= LIST_HEAD_SCAN_BYTES;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      if (!line.trim()) {
        if (!scanWholePrefix && bytes >= LIST_HEAD_SCAN_BYTES) break;
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        if (!header) throw malformed();
        if (!scanWholePrefix && bytes >= LIST_HEAD_SCAN_BYTES) break;
        continue;
      }
      if (!header) {
        if (!isSessionHeader(entry)) throw malformed();
        header = entry;
      } else if (entry?.type === 'session_info') {
        name = sessionInfoName(entry);
      } else if (!firstMessage && entry?.type === 'message' && entry.message?.role === 'user') {
        const preview = extractUserPreview(entry.message);
        if (preview) firstMessage = trimPreview(preview);
      }
      if (!scanWholePrefix && header && firstMessage) break;
      if (!scanWholePrefix && bytes >= LIST_HEAD_SCAN_BYTES) break;
    }
  } catch (error) {
    if (error instanceof SessionJsonlError) throw error;
    throw unreadable();
  } finally {
    lines.close();
    input.destroy();
  }
  if (!header) throw malformed();
  return { header, name, firstMessage };
}

/**
 * Sidebar/list metadata for one cwd. Reads a header, a bounded prefix for
 * the first user prompt, and a tail for the latest rename. It does not
 * load whole transcripts. Files in the directory are read with bounded
 * concurrency; one unreadable or header-malformed file still fails the
 * whole directory list.
 */
export async function listPiSessionJsonlDirectory({
  cwd,
  agentDir,
  platform = process.platform,
  resolvePath = resolve,
} = {}) {
  let sessionDirectory;
  let entries;
  try {
    sessionDirectory = getPiSessionDirectory({ cwd, agentDir, platform, resolvePath });
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    entries = await readdir(sessionDirectory, { withFileTypes: true });
  } catch {
    throw unreadable();
  }

  const files = entries.filter((entry) => entry.name.endsWith('.jsonl') && !entry.isDirectory());
  const sessions = await mapWithConcurrency(files, LIST_FILE_CONCURRENCY, async (entry) => {
    const filePath = join(sessionDirectory, entry.name);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw unreadable();
    }
    const fields = await readPiSessionJsonlListFields(filePath, fileStat.size);
    const tail = fileStat.size > LIST_HEAD_SCAN_BYTES
      ? await readLatestSessionInfoFromTail(filePath, fileStat.size)
      : null;
    const name = tail?.name ?? fields.name;
    const headerTime = typeof fields.header.timestamp === 'string'
      ? Date.parse(fields.header.timestamp)
      : NaN;
    const created = Number.isFinite(headerTime) ? new Date(headerTime) : fileStat.mtime;
    return {
      path: filePath,
      id: fields.header.id,
      cwd: fields.header.cwd,
      ...(name ? { name } : {}),
      ...(typeof fields.header.parentSession === 'string' ? { parentSessionPath: fields.header.parentSession } : {}),
      created,
      modified: fileStat.mtime,
      ...(fields.firstMessage ? { firstMessage: fields.firstMessage } : {}),
    };
  });
  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return sessions;
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
    if (!entry.name.endsWith('.jsonl') || entry.isDirectory()) continue;
    await readPiSessionJsonlHeader(join(sessionDirectory, entry.name));
  }
}
