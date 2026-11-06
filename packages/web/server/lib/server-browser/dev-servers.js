import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const MAX_CANDIDATES = 48;
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 800;
const PROBE_MAX_BYTES = 64 * 1024;
const CACHE_MS = 3_000;
const MIN_PORT = 1024;

const LISTEN_STATE = '0A';
const V4_ANY = '00000000';
const V6_ANY = '0'.repeat(32);
const V6_LOOPBACK = '00000000000000000000000001000000';
const V4_MAPPED_PREFIX = '0000000000000000FFFF0000';

const reachableFromLoopback = (hexAddress) => {
  const address = hexAddress.toUpperCase();
  if (address.length === 8) return address === V4_ANY || address.endsWith('7F') ? '127.0.0.1' : null;
  if (address === V6_ANY || address === V6_LOOPBACK) return '::1';
  if (address.startsWith(V4_MAPPED_PREFIX)) {
    const v4 = address.slice(V4_MAPPED_PREFIX.length);
    return v4 === V4_ANY || v4.endsWith('7F') ? '127.0.0.1' : null;
  }
  return null;
};

/**
 * Listening sockets from a Linux `/proc/net/tcp` or `tcp6` table that a
 * loopback request can reach.
 */
export const parseProcNetTcp = (text) => {
  const sockets = [];
  for (const line of String(text).split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue;
    const [hexAddress, hexPort] = fields[1].split(':');
    const host = reachableFromLoopback(hexAddress || '');
    const port = Number.parseInt(hexPort || '', 16);
    if (!host || !Number.isInteger(port) || port <= 0) continue;
    sockets.push({ host, port, inode: fields[9] });
  }
  return sockets;
};

/** Listening sockets and their processes from `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`. */
export const parseLsofListen = (text) => {
  const sockets = [];
  let pid = null;
  let command = null;
  for (const line of String(text).split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number.parseInt(value, 10);
      command = null;
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n') {
      const match = /^(.*):(\d+)$/.exec(value);
      if (!match) continue;
      const address = match[1];
      const port = Number.parseInt(match[2], 10);
      let host = null;
      if (address === '*' || address === '127.0.0.1' || address.startsWith('127.')) host = '127.0.0.1';
      else if (address === '[::1]' || address === '[::]') host = '::1';
      if (host) sockets.push({ host, port, pid, command });
    }
  }
  return sockets;
};

/** Parses `lsof -a -d cwd -p <pids> -Fpn` into a pid → cwd map. */
export const parseLsofCwd = (text) => {
  const cwds = new Map();
  let pid = null;
  for (const line of String(text).split('\n')) {
    if (line[0] === 'p') pid = Number.parseInt(line.slice(1), 10);
    else if (line[0] === 'n' && pid !== null) cwds.set(pid, line.slice(1));
  }
  return cwds;
};

/** The `<title>` of an HTML document, trimmed and collapsed. */
const extractTitle = (html) => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  if (!match) return null;
  const title = match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return title ? title.slice(0, 120) : null;
};

const isWithinDirectory = (child, directory) => {
  if (!child || !directory) return false;
  const relative = path.relative(path.resolve(directory), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Sends `GET /` and resolves with the page title, or `undefined` when the port does not speak HTTP. */
const probeHttp = ({ host, port }) => new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  const request = http.request({
    host,
    port,
    path: '/',
    method: 'GET',
    headers: { accept: 'text/html,*/*;q=0.8', 'user-agent': 'PiChamber dev server discovery' },
    timeout: PROBE_TIMEOUT_MS,
  }, (response) => {
    const isHtml = /text\/html/i.test(String(response.headers['content-type'] || ''));
    if (!isHtml) {
      response.destroy();
      finish(null);
      return;
    }
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
      if (body.length >= PROBE_MAX_BYTES || /<\/title>/i.test(body)) {
        response.destroy();
        finish(extractTitle(body));
      }
    });
    response.on('end', () => finish(extractTitle(body)));
    response.on('error', () => finish(extractTitle(body)));
  });
  request.on('timeout', () => { request.destroy(); finish(undefined); });
  request.on('error', () => finish(undefined));
  request.end();
});

const mapLimit = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
};

const execFileText = (file, args) => new Promise((resolve) => {
  execFileCallback(file, args, { timeout: 2_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    // lsof exits 1 when nothing matched; its output is still usable.
    resolve(error && !stdout ? '' : String(stdout || ''));
  });
});

const linuxListeners = async ({ readFile, readdir, readlink }) => {
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((file) => readFile(file, 'utf8').catch(() => '')));
  const sockets = tables.flatMap(parseProcNetTcp);
  if (sockets.length === 0) return [];

  // Match socket inodes to the processes this user can see.
  const wanted = new Set(sockets.map((socket) => socket.inode));
  const owners = new Map();
  const pids = (await readdir('/proc').catch(() => [])).filter((name) => /^\d+$/.test(name));
  await mapLimit(pids, 16, async (pid) => {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && wanted.has(inode) && !owners.has(inode)) owners.set(inode, Number(pid));
    }
  });

  const processInfo = new Map();
  const infoFor = async (pid) => {
    if (!processInfo.has(pid)) {
      // The executable's name: runtimes such as Node rename their main
      // thread, so `comm` often reads "MainThread".
      processInfo.set(pid, Promise.all([
        readlink(`/proc/${pid}/exe`).then((exe) => path.basename(exe.replace(/ \(deleted\)$/, ''))).catch(() => null),
        readFile(`/proc/${pid}/comm`, 'utf8').then((text) => text.trim()).catch(() => null),
        readlink(`/proc/${pid}/cwd`).catch(() => null),
      ]).then(([exe, comm, cwd]) => ({ command: exe || comm, cwd })));
    }
    return processInfo.get(pid);
  };

  return Promise.all(sockets.map(async (socket) => {
    const pid = owners.get(socket.inode) ?? null;
    const info = pid === null ? { command: null, cwd: null } : await infoFor(pid);
    return { host: socket.host, port: socket.port, pid, command: info.command, cwd: info.cwd };
  }));
};

const macListeners = async ({ execFile }) => {
  const sockets = parseLsofListen(await execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
  const pids = [...new Set(sockets.map((socket) => socket.pid).filter(Number.isInteger))];
  const cwds = pids.length > 0
    ? parseLsofCwd(await execFile('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']))
    : new Map();
  return sockets.map((socket) => ({ ...socket, cwd: cwds.get(socket.pid) ?? null }));
};

/**
 * Finds web servers listening on this machine's loopback interface, such as
 * dev servers an agent started. Reports the port, page title, process name,
 * and whether the process runs inside the project; never command lines or
 * paths.
 */
export const createDevServerFinder = ({
  platform = process.platform,
  readFile = fs.readFile,
  readdir = fs.readdir,
  readlink = fs.readlink,
  execFile = execFileText,
  probe = probeHttp,
  ownPid = process.pid,
  now = Date.now,
} = {}) => {
  let cache = null;

  const listListeners = async () => {
    if (platform === 'linux') return linuxListeners({ readFile, readdir, readlink });
    if (platform === 'darwin') return macListeners({ execFile });
    return null;
  };

  const scan = async () => {
    const listeners = await listListeners();
    if (!listeners) return { supported: false, listeners: [] };
    // One entry per port; an IPv4 listener answers the loopback probe most reliably.
    const byPort = new Map();
    for (const listener of listeners) {
      if (listener.port < MIN_PORT || listener.pid === ownPid) continue;
      const existing = byPort.get(listener.port);
      if (!existing || (existing.host !== '127.0.0.1' && listener.host === '127.0.0.1') || (!existing.pid && listener.pid)) {
        byPort.set(listener.port, { ...listener, pid: listener.pid ?? existing?.pid ?? null, command: listener.command ?? existing?.command ?? null, cwd: listener.cwd ?? existing?.cwd ?? null });
      }
    }
    // Ports a visible process owns first; others are usually system services.
    const candidates = [...byPort.values()]
      .sort((a, b) => Number(Boolean(b.pid)) - Number(Boolean(a.pid)) || a.port - b.port)
      .slice(0, MAX_CANDIDATES);
    const titles = await mapLimit(candidates, PROBE_CONCURRENCY, (candidate) => probe(candidate));
    return {
      supported: true,
      listeners: candidates
        .map((candidate, index) => ({ ...candidate, title: titles[index] }))
        .filter((candidate) => candidate.title !== undefined),
    };
  };

  const listeners = () => {
    if (cache && now() - cache.at < CACHE_MS) return cache.promise;
    const promise = scan().catch(() => ({ supported: true, listeners: [] }));
    cache = { at: now(), promise };
    return promise;
  };

  return {
    /** Web servers for a project, its own first. `excludePorts` hides PiChamber's own ports. */
    async find({ directory = null, excludePorts = [] } = {}) {
      const { supported, listeners: found } = await listeners();
      const excluded = new Set(excludePorts);
      const servers = found
        .filter((listener) => !excluded.has(listener.port))
        .map((listener) => ({
          url: `http://localhost:${listener.port}/`,
          port: listener.port,
          title: listener.title || null,
          process: listener.command || null,
          inProject: isWithinDirectory(listener.cwd, directory),
        }))
        .sort((a, b) => Number(b.inProject) - Number(a.inProject) || a.port - b.port);
      return { supported, servers };
    },
  };
};
