import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import {
  resolvePiChamberDataDir as resolveVsCodeDataDir,
  resolvePiChamberDataPath as resolveVsCodeDataPath,
} from './pichamberDataDir';

async function loadWebResolver(): Promise<{
  resolvePiChamberDataDir: typeof resolveVsCodeDataDir;
  resolvePiChamberDataPath: typeof resolveVsCodeDataPath;
}> {
  const webModule = '../../web/server/lib/pichamber-data-dir.js';
  const absolute = path.resolve(__dirname, webModule);
  // dynamic ESM import for an absolute path requires file:// URLs in node:test
  return import((await import('node:url')).pathToFileURL(absolute).href);
}

describe('pichamberDataDir parity with web resolver', () => {
  test('VS Code and web resolvers agree on the default for any home directory', async () => {
    const web = await loadWebResolver();
    const cases = ['/home/u', '/Users/dev', '/root', '/var/empty'];
    for (const home of cases) {
      const deps = { env: {}, homedir: () => home, path };
      assert.equal(resolveVsCodeDataDir(deps), web.resolvePiChamberDataDir(deps));
    }
  });

  test('VS Code and web resolvers agree on whitespace-trimmed absolute overrides', async () => {
    const web = await loadWebResolver();
    const deps = {
      env: { OPENCHAMBER_DATA_DIR: '   /tmp/custom-pichamber   ' },
      homedir: () => '/home/u',
      path,
    };
    assert.equal(resolveVsCodeDataDir(deps), web.resolvePiChamberDataDir(deps));
  });

  test('VS Code and web resolvers agree on relative overrides resolved against cwd', async () => {
    const web = await loadWebResolver();
    const deps = {
      env: { OPENCHAMBER_DATA_DIR: 'var/data' },
      homedir: () => '/home/u',
      path,
    };
    assert.equal(resolveVsCodeDataDir(deps), web.resolvePiChamberDataDir(deps));
  });

  test('child paths stay beneath the effective root in both resolvers', async () => {
    const web = await loadWebResolver();
    const deps = { env: {}, homedir: () => '/home/u', path };
    const root = resolveVsCodeDataDir(deps);
    const childSegments: Array<string | string[]> = [
      'settings.json',
      ['managed-opencode'],
      ['projects', 'p1.json'],
      ['themes', 'a.json'],
      ['quota', 'creds.json'],
    ];
    for (const segments of childSegments) {
      const child = resolveVsCodeDataPath(segments, deps);
      const webChild = web.resolvePiChamberDataPath(segments, deps);
      assert.equal(child, webChild);
      assert.ok(child.startsWith(root + path.sep), `expected ${child} to start with ${root}${path.sep}`);
    }
  });

  test('production call without deps still resolves under <homedir>/.config/pichamber', () => {
    const resolved = resolveVsCodeDataDir();
    assert.ok(resolved.endsWith(`${path.sep}.config${path.sep}pichamber`));
  });
});
