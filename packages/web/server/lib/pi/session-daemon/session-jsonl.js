import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

/** Chunk size for streaming list scans; bounds memory on cold scans. */
const LIST_SCAN_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;
const SESSION_INFO_TOKEN = Buffer.from('"session_info"');
const USER_TOKEN = Buffer.from('"user"');

/**
 * Per-file list metadata cache. Entries are keyed by absolute path and
 * validated by dev/ino + size + mtimeMs. `stats` counts disk work so tests
 * can prove the unchanged-file path is stat-only.
 */
export const createPiSessionJsonlListCache = () => ({
  entries: new Map(),
  stats: { fullScans: 0, incrementalScans: 0, bytesRead: 0 },
});

const defaultListCache = createPiSessionJsonlListCache();

const isBlankLine = (buffer, start, end) => {
  for (let index = start; index < end; index += 1) {
    const byte = buffer[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a) return false;
  }
  return true;
};

const parseLine = (buffer, start, end) => {
  try {
    return { entry: JSON.parse(buffer.toString('utf8', start, end)) };
  } catch {
    return null;
  }
};

const includesToken = (buffer, start, end, token) => {
  const at = buffer.indexOf(token, start);
  return at !== -1 && at + token.length <= end;
};

/**
 * Apply complete lines in `buffer[0, end)` to `state`. Before the first user
 * prompt is known every line carrying a `"user"` token is parsed; afterwards
 * only lines containing the raw `"session_info"` token are parsed. Latest
 * `session_info` wins, including an explicit clear (empty name).
 */
const applyCompleteLines = (state, buffer, end) => {
  let lineStart = 0;
  while (lineStart < end) {
    if (state.header && state.firstMessageFound) {
      // Jump straight to the next rename candidate.
      const tokenAt = buffer.indexOf(SESSION_INFO_TOKEN, lineStart);
      if (tokenAt === -1 || tokenAt >= end) return;
      const previousNewline = buffer.lastIndexOf(NEWLINE, tokenAt);
      lineStart = previousNewline === -1 ? 0 : previousNewline + 1;
    }
    let lineEnd = buffer.indexOf(NEWLINE, lineStart);
    if (lineEnd === -1 || lineEnd > end) lineEnd = end;
    if (!isBlankLine(buffer, lineStart, lineEnd)) {
      if (!state.header) {
        const parsed = parseLine(buffer, lineStart, lineEnd);
        if (!parsed || !isSessionHeader(parsed.entry)) throw malformed();
        state.header = parsed.entry;
      } else {
        const maybeInfo = includesToken(buffer, lineStart, lineEnd, SESSION_INFO_TOKEN);
        const maybeUser = !state.firstMessageFound && includesToken(buffer, lineStart, lineEnd, USER_TOKEN);
        if (maybeInfo || maybeUser) {
          const entry = parseLine(buffer, lineStart, lineEnd)?.entry;
          if (entry?.type === 'session_info') {
            state.name = sessionInfoName(entry);
          } else if (!state.firstMessageFound && entry?.type === 'message' && entry.message?.role === 'user') {
            const preview = extractUserPreview(entry.message);
            if (preview) {
              state.firstMessage = trimPreview(preview);
              state.firstMessageFound = true;
            }
          }
        }
      }
    }
    lineStart = lineEnd + 1;
  }
};

/**
 * Stream `[state.offset, size)` in chunks, applying complete lines and
 * advancing `state.offset` to just after the last complete newline. A
 * trailing partial line is left for the next scan; when no header exists
 * yet it is parsed transiently so a header-only file without a newline
 * still lists, as before.
 */
async function scanPiSessionJsonlRange(filePath, state, size, stats) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    let position = state.offset;
    let carry = [];
    let carryBytes = 0;
    while (position < size) {
      const length = Math.min(LIST_SCAN_CHUNK_BYTES, size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) break;
      stats.bytesRead += bytesRead;
      position += bytesRead;
      const data = chunk.subarray(0, bytesRead);
      const lastNewline = data.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        carry.push(data);
        carryBytes += data.length;
        continue;
      }
      const complete = carry.length > 0
        ? Buffer.concat([...carry, data.subarray(0, lastNewline + 1)])
        : data.subarray(0, lastNewline + 1);
      applyCompleteLines(state, complete, complete.length);
      state.offset += complete.length;
      carry = lastNewline + 1 < data.length ? [data.subarray(lastNewline + 1)] : [];
      carryBytes = carry.length > 0 ? carry[0].length : 0;
    }
    if (!state.header && carryBytes > 0) {
      const tail = Buffer.concat(carry);
      if (!isBlankLine(tail, 0, tail.length)) {
        const parsed = parseLine(tail, 0, tail.length);
        if (!parsed || !isSessionHeader(parsed.entry)) throw malformed();
        state.header = parsed.entry;
      }
    }
  } catch (error) {
    if (error instanceof SessionJsonlError) throw error;
    throw unreadable();
  } finally {
    await handle?.close().catch(() => {});
  }
  if (!state.header) throw malformed();
}

const sameFileIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

/**
 * Return list fields for one file, reusing the cache when the file is
 * unchanged (stat only) and scanning only appended bytes when it grew in
 * place. Shrunk, replaced, or rewritten files are rescanned from zero.
 */
async function readPiSessionJsonlListFieldsCached(filePath, fileStat, cache) {
  const cached = cache.entries.get(filePath);
  if (cached && sameFileIdentity(cached, fileStat)
    && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.state;
  }
  const incremental = Boolean(cached && sameFileIdentity(cached, fileStat)
    && fileStat.size > cached.size && cached.state.offset <= fileStat.size);
  const state = incremental
    ? { ...cached.state }
    : { offset: 0, header: undefined, name: undefined, firstMessage: undefined, firstMessageFound: false };
  if (incremental) cache.stats.incrementalScans += 1;
  else cache.stats.fullScans += 1;
  try {
    await scanPiSessionJsonlRange(filePath, state, fileStat.size, cache.stats);
  } catch (error) {
    cache.entries.delete(filePath);
    throw error;
  }
  cache.entries.set(filePath, {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    state,
  });
  return state;
}

/**
 * Sidebar/list metadata for one cwd. Each file's header, first user prompt,
 * and latest `session_info` come from an in-memory cache validated by
 * dev/ino + size + mtime: unchanged files cost one `stat`, appended files
 * scan only the new bytes, and cold scans stream in fixed-size chunks.
 * Cache entries for files no longer in the directory are pruned. Files are
 * processed with bounded concurrency; one unreadable or header-malformed
 * file still fails the whole directory list.
 */
export async function listPiSessionJsonlDirectory({
  cwd,
  agentDir,
  platform = process.platform,
  resolvePath = resolve,
  cache = defaultListCache,
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
  const livePaths = new Set(files.map((entry) => join(sessionDirectory, entry.name)));
  for (const cachedPath of cache.entries.keys()) {
    if (dirname(cachedPath) === sessionDirectory && !livePaths.has(cachedPath)) cache.entries.delete(cachedPath);
  }
  const sessions = await mapWithConcurrency(files, LIST_FILE_CONCURRENCY, async (entry) => {
    const filePath = join(sessionDirectory, entry.name);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      cache.entries.delete(filePath);
      throw unreadable();
    }
    const fields = await readPiSessionJsonlListFieldsCached(filePath, fileStat, cache);
    const name = fields.name;
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
