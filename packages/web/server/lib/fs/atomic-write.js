import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

const MAX_SYMLINK_HOPS = 40;

const symlinkLoopError = (file) => {
  const error = new Error(`Too many symbolic links while resolving ${file}`);
  error.code = 'ELOOP';
  return error;
};

const isMissingOrNotLink = (error) => error?.code === 'ENOENT' || error?.code === 'EINVAL' || error?.code === 'UNKNOWN';

const temporaryPathFor = (target) => `${target}.tmp-${process.pid}-${randomUUID()}`;

/**
 * Resolve the path an atomic write must replace so a symlinked file (for
 * example a GNU Stow-managed config) keeps its link. Existing targets resolve
 * through realpath. A missing file resolves to itself. A dangling link resolves
 * to the path it points at, relative to the link's directory.
 */
const resolveAtomicWriteTarget = async (file, fs = fsPromises) => {
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let current = file;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let link;
    try {
      link = await fs.readlink(current);
    } catch (error) {
      if (isMissingOrNotLink(error)) return current;
      throw error;
    }
    current = path.resolve(path.dirname(current), link);
  }
  throw symlinkLoopError(file);
};

const resolveAtomicWriteTargetSync = (file, fs = fsSync) => {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let current = file;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let link;
    try {
      link = fs.readlinkSync(current);
    } catch (error) {
      if (isMissingOrNotLink(error)) return current;
      throw error;
    }
    current = path.resolve(path.dirname(current), link);
  }
  throw symlinkLoopError(file);
};

/**
 * Atomically replace `file` with `data` (temp file + rename in the real
 * target's directory) without replacing a symlink at `file`. Returns the path
 * that was written. Callers own any cross-process locking; keep lock keys on
 * the caller-facing `file` path.
 */
export const writeFileAtomic = async (file, data, {
  fs = fsPromises,
  encoding = 'utf8',
  mode = 0o600,
  dirMode = 0o700,
} = {}) => {
  const target = await resolveAtomicWriteTarget(file, fs);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: dirMode });
  const temporary = temporaryPathFor(target);
  try {
    await fs.writeFile(temporary, data, { encoding, mode });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  // Best effort: the new content is already in place, so a chmod failure must not fail the save.
  if (process.platform !== 'win32') await fs.chmod(target, mode).catch(() => {});
  return target;
};

export const writeFileAtomicSync = (file, data, {
  fs = fsSync,
  encoding = 'utf8',
  mode = 0o600,
  dirMode = 0o700,
} = {}) => {
  const target = resolveAtomicWriteTargetSync(file, fs);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: dirMode });
  const temporary = temporaryPathFor(target);
  try {
    fs.writeFileSync(temporary, data, { encoding, mode });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(target, mode); } catch {}
  }
  return target;
};
