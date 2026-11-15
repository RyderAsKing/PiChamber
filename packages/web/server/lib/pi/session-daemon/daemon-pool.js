import { createHash } from 'node:crypto';
import path from 'node:path';

export const MAIN_DAEMON_KEY = 'main';

/**
 * Public, opaque id of a daemon's event stream. Pool keys may be server
 * paths, which never leave the server; a project daemon's id is a stable
 * 16-character hash so a resume cursor stays valid across PiChamber
 * restarts. The main daemon's id is `main`: frames and responses from it
 * carry no id at all, and `main` only appears where a value from the main
 * daemon sits inside a project daemon's response (a draining list row).
 */
export const publicDaemonStreamId = (key) => (key === MAIN_DAEMON_KEY ? MAIN_DAEMON_KEY : hashDaemonKey(key));

const hashDaemonKey = (key) => createHash('sha256').update(`pichamber-daemon:${key}`).digest('base64url').slice(0, 16);

const normalizeDirectory = (directory) => (
  typeof directory === 'string' && directory.length > 0 && path.isAbsolute(directory)
    ? path.resolve(directory)
    : null
);

const contains = (root, directory) => directory === root
  || directory.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/**
 * The session daemons this server talks to: the main daemon (the
 * supervisor's runtime, always present once started) plus zero or more
 * project daemons, each keyed by project and owning that project's root and
 * worktree roots. Routes ask the pool which daemon owns a directory;
 * anything outside every project daemon belongs to the main daemon.
 *
 * Draining: while a project switches daemons, the old daemon keeps live
 * state for sessions still finishing a turn there. `setDraining` names the
 * daemons whose live state is merged into that directory's session list.
 */
export const createPiDaemonPool = ({ getMainRuntime }) => {
  const projects = new Map();
  const draining = new Map();
  const listeners = new Set();
  const moveListeners = new Set();

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[pi] daemon pool listener failed', error?.code ?? error);
      }
    }
  };

  const runtimeFor = (key) => (key === MAIN_DAEMON_KEY ? getMainRuntime() ?? null : projects.get(key)?.runtime ?? null);

  const ownerKey = (directory) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized) return MAIN_DAEMON_KEY;
    let best = null;
    let bestLength = -1;
    for (const [key, entry] of projects) {
      for (const root of entry.directories) {
        if (root.length > bestLength && contains(root, normalized)) {
          best = key;
          bestLength = root.length;
        }
      }
    }
    return best ?? MAIN_DAEMON_KEY;
  };

  return {
    /** The main daemon's runtime, or null before it exists. */
    main: () => getMainRuntime() ?? null,
    /** The runtime owning `directory` (project root or worktree root, or any
     *  folder inside one); the main daemon when no project daemon owns it. */
    forDirectory: (directory) => runtimeFor(ownerKey(directory)),
    /** Daemons (`{ key, runtime }`) whose live state merges into
     *  `directory`'s session list while a switch drains. Never includes the
     *  owner. */
    drainingFor: (directory) => {
      const owner = ownerKey(directory);
      const normalized = normalizeDirectory(directory);
      if (!normalized) return [];
      const keys = new Set();
      for (const [root, rootKeys] of draining) {
        if (!contains(root, normalized)) continue;
        for (const key of rootKeys) if (key !== owner) keys.add(key);
      }
      return [...keys].map((key) => ({ key, runtime: runtimeFor(key) })).filter((item) => item.runtime);
    },
    /** Public stream id of the daemon owning `directory`, or undefined for
     *  the main daemon (whose responses and frames carry none). */
    streamFor: (directory) => {
      const key = ownerKey(directory);
      return key === MAIN_DAEMON_KEY ? undefined : publicDaemonStreamId(key);
    },
    /** Every daemon that is running, main first. */
    live: () => {
      const result = [];
      const main = getMainRuntime();
      if (main) result.push({ key: MAIN_DAEMON_KEY, runtime: main });
      // A project runtime whose daemon is not running (`isLive()` false)
      // is left out: fan-out never starts a daemon.
      for (const [key, entry] of projects) {
        if (entry.runtime.isLive?.() === false) continue;
        result.push({ key, runtime: entry.runtime });
      }
      return result;
    },
    register: (key, { runtime, directories }) => {
      if (typeof key !== 'string' || key.length === 0 || key === MAIN_DAEMON_KEY) throw new TypeError('Invalid daemon key');
      if (!runtime || typeof runtime.request !== 'function') throw new TypeError('Invalid daemon runtime');
      const roots = (directories ?? []).map(normalizeDirectory);
      if (roots.length === 0 || roots.some((root) => root === null)) throw new TypeError('Invalid daemon directories');
      projects.set(key, { runtime, directories: roots });
      notify();
    },
    unregister: (key) => {
      if (projects.delete(key)) notify();
    },
    /** Name the daemons still holding live sessions for `directory`; an
     *  empty list ends the drain. */
    setDraining: (directory, keys) => {
      const normalized = normalizeDirectory(directory);
      if (!normalized) throw new TypeError('Invalid directory');
      if (!Array.isArray(keys) || keys.length === 0) draining.delete(normalized);
      else draining.set(normalized, [...new Set(keys)]);
    },
    /** Tell event stream subscribers that a session's live owner changed
     *  (for example a switch disposed it in one daemon), so clients refetch
     *  it from its new owner. */
    announceMove: (sessionId, directory) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || !normalizeDirectory(directory)) return;
      for (const listener of [...moveListeners]) {
        try {
          listener(sessionId, directory);
        } catch (error) {
          console.warn('[pi] daemon pool move listener failed', error?.code ?? error);
        }
      }
    },
    onMove: (listener) => {
      moveListeners.add(listener);
      return () => moveListeners.delete(listener);
    },
    /** Called when a daemon is registered, replaced, or unregistered. */
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
