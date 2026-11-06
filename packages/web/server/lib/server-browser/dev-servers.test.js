import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDevServerFinder,
  parseLsofCwd,
  parseLsofListen,
  parseProcNetTcp,
} from './dev-servers.js';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (local, state, inode) => `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0 100 0 0 10 0`;

describe('parseProcNetTcp', () => {
  it('keeps listening sockets a loopback request can reach', () => {
    const v4 = [
      HEADER,
      row('0100007F:1435', '0A', '11'), // 127.0.0.1:5173
      row('00000000:0BB8', '0A', '12'), // 0.0.0.0:3000
      row('0100A8C0:1F90', '0A', '13'), // 192.168.0.1:8080, not loopback
      row('0100007F:1F91', '01', '14'), // established, not listening
    ].join('\n');
    expect(parseProcNetTcp(v4)).toEqual([
      { host: '127.0.0.1', port: 5173, inode: '11' },
      { host: '127.0.0.1', port: 3000, inode: '12' },
    ]);

    const v6 = [
      HEADER,
      row('00000000000000000000000001000000:2328', '0A', '21'), // [::1]:9000
      row('0000000000000000FFFF00000100007F:2329', '0A', '22'), // ::ffff:127.0.0.1:9001
      row('B80D0120000000000000000001000000:232A', '0A', '23'), // 2001:db8::1, not loopback
    ].join('\n');
    expect(parseProcNetTcp(v6)).toEqual([
      { host: '::1', port: 9000, inode: '21' },
      { host: '127.0.0.1', port: 9001, inode: '22' },
    ]);
  });
});

describe('lsof parsing', () => {
  it('reads listening sockets and working directories', () => {
    const listen = ['p101', 'cnode', 'n*:5173', 'n[::1]:5173', 'p202', 'cpostgres', 'n10.0.0.2:5432', ''].join('\n');
    expect(parseLsofListen(listen)).toEqual([
      { host: '127.0.0.1', port: 5173, pid: 101, command: 'node' },
      { host: '::1', port: 5173, pid: 101, command: 'node' },
    ]);
    expect(parseLsofCwd(['p101', 'fcwd', 'n/Users/me/app', ''].join('\n'))).toEqual(new Map([[101, '/Users/me/app']]));
  });
});

describe('createDevServerFinder', () => {
  const linuxFs = (files, links, dirs) => ({
    platform: 'linux',
    readFile: async (file) => {
      if (file in files) return files[file];
      throw new Error('ENOENT');
    },
    readlink: async (file) => {
      if (file in links) return links[file];
      throw new Error('ENOENT');
    },
    readdir: async (dir) => {
      if (dir in dirs) return dirs[dir];
      throw new Error('ENOENT');
    },
  });

  it('lists web servers with their project first and skips PiChamber and non-HTTP ports', async () => {
    const tcp = [
      HEADER,
      row('0100007F:1435', '0A', '11'), // 5173, owned by pid 50 in the project
      row('00000000:0BB8', '0A', '12'), // 3000, owned by pid 60 elsewhere
      row('00000000:18EB', '0A', '13'), // 6379, not HTTP
      row('00000000:0016', '0A', '14'), // 22, below 1024
      row('00000000:2710', '0A', '15'), // 10000, PiChamber's own port
    ].join('\n');
    const probes = [];
    const finder = createDevServerFinder({
      ...linuxFs(
        { '/proc/net/tcp': tcp, '/proc/50/comm': 'MainThread\n', '/proc/60/comm': 'python3\n' },
        {
          '/proc/50/fd/3': 'socket:[11]',
          '/proc/60/fd/4': 'socket:[12]',
          '/proc/50/exe': '/usr/bin/node',
          '/proc/50/cwd': '/repo/app/web',
          '/proc/60/cwd': '/tmp',
        },
        { '/proc': ['50', '60', 'self'], '/proc/50/fd': ['3'], '/proc/60/fd': ['4'] },
      ),
      probe: async ({ port }) => {
        probes.push(port);
        return { 5173: 'Vite App', 3000: null, 6379: undefined, 10000: 'PiChamber' }[port];
      },
      ownPid: 1,
    });

    const result = await finder.find({ directory: '/repo/app', excludePorts: [10000] });
    expect(result).toEqual({
      supported: true,
      servers: [
        { url: 'http://localhost:5173/', port: 5173, title: 'Vite App', process: 'node', inProject: true },
        { url: 'http://localhost:3000/', port: 3000, title: null, process: 'python3', inProject: false },
      ],
    });
    expect(probes).not.toContain(22);
  });

  it('reuses a recent scan', async () => {
    let scans = 0;
    let time = 0;
    const finder = createDevServerFinder({
      ...linuxFs({ '/proc/net/tcp': [HEADER, row('0100007F:1435', '0A', '11')].join('\n') }, {}, { '/proc': [] }),
      probe: async () => { scans += 1; return 'App'; },
      now: () => time,
    });
    await finder.find();
    await finder.find();
    expect(scans).toBe(1);
    time = 10_000;
    await finder.find();
    expect(scans).toBe(2);
  });
});

describe('dev server probe', () => {
  let server = null;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    server = null;
  });

  it('reads the title from a real loopback server', async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Fixture</title><p>hi</p>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const finder = createDevServerFinder({
      platform: 'linux',
      readFile: async (file) => (file === '/proc/net/tcp'
        ? [HEADER, row(`0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`, '0A', '1')].join('\n')
        : ''),
      readdir: async () => [],
      readlink: async () => { throw new Error('ENOENT'); },
    });
    const { servers } = await finder.find();
    expect(servers).toEqual([{ url: `http://localhost:${port}/`, port, title: 'Fixture', process: null, inProject: false }]);
  });
});
