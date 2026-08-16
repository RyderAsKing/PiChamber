import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG_DIR_NAME,
  resolvePiChamberDataDir,
  resolvePiChamberDataPath,
} from './pichamber-data-dir.js';

const withHome = (home) => ({ env: {}, homedir: () => home, path });

describe('resolvePiChamberDataDir', () => {
  it('falls back to <home>/.config/pichamber when no override is set', () => {
    expect(resolvePiChamberDataDir({ env: {}, homedir: () => '/home/u', path })).toBe(
      path.join('/home/u', '.config', 'pichamber'),
    );
  });

  it('resolves non-empty whitespace-trimmed overrides absolutely', () => {
    expect(
      resolvePiChamberDataDir({ env: { PICHAMBER_DATA_DIR: '   /tmp/pichamber-data   ' }, homedir: () => '/home/u', path }),
    ).toBe(path.resolve('/tmp/pichamber-data'));
  });

  it('normalizes relative overrides against the current working directory', () => {
    const resolved = resolvePiChamberDataDir({
      env: { PICHAMBER_DATA_DIR: 'var/pichamber' },
      homedir: () => '/home/u',
      path,
    });
    expect(resolved).toBe(path.resolve(process.cwd(), 'var/pichamber'));
  });

  it('treats whitespace-only overrides as absent and falls back', () => {
    expect(
      resolvePiChamberDataDir({ env: { PICHAMBER_DATA_DIR: '   ' }, homedir: () => '/home/u', path }),
    ).toBe(path.join('/home/u', '.config', 'pichamber'));
  });

  it('treats empty-string overrides as absent', () => {
    expect(
      resolvePiChamberDataDir({ env: { PICHAMBER_DATA_DIR: '' }, homedir: () => '/home/u', path }),
    ).toBe(path.join('/home/u', '.config', 'pichamber'));
  });

  it('does not consult any legacy openchamber data dir fallback', () => {
    expect(DEFAULT_CONFIG_DIR_NAME).toBe('pichamber');
    const resolved = resolvePiChamberDataDir({ env: {}, homedir: () => '/home/u', path });
    expect(resolved.endsWith('.config/openchamber')).toBe(false);
    expect(resolved.endsWith('.config/pichamber')).toBe(true);
  });

  it('uses the production defaults when called without dependencies', () => {
    const expectedDefault = path.join(process.cwd() === '/' ? '/' : '', '.config', 'pichamber');
    // Sanity check: importing and using no-arg form shouldn't crash and must
    // resolve under <homedir>/.config/pichamber.
    const resolved = resolvePiChamberDataDir();
    expect(resolved.endsWith(`${path.sep}.config${path.sep}pichamber`)).toBe(true);
    expect(expectedDefault === '' || typeof expectedDefault === 'string').toBe(true);
  });
});

describe('resolvePiChamberDataPath', () => {
  const deps = { env: {}, homedir: () => '/home/u', path };

  it('returns the effective root when no segment is requested', () => {
    expect(resolvePiChamberDataPath(undefined, deps)).toBe(path.join('/home/u', '.config', 'pichamber'));
  });

  it('joins a single segment beneath the effective root', () => {
    expect(resolvePiChamberDataPath('settings.json', deps)).toBe(
      path.join('/home/u', '.config', 'pichamber', 'settings.json'),
    );
  });

  it('joins an array of segments beneath the effective root', () => {
    expect(resolvePiChamberDataPath(['themes', 'solarized.json'], deps)).toBe(
      path.join('/home/u', '.config', 'pichamber', 'themes', 'solarized.json'),
    );
  });

  it('honors PICHAMBER_DATA_DIR overrides', () => {
    expect(
      resolvePiChamberDataPath('settings.json', {
        env: { PICHAMBER_DATA_DIR: '/custom/root' },
        homedir: () => '/home/u',
        path,
      }),
    ).toBe(path.join('/custom/root', 'settings.json'));
  });

  it('every child path stays beneath the effective root', () => {
    const root = resolvePiChamberDataDir(deps);
    const children = [
      resolvePiChamberDataPath('settings.json', deps),
      resolvePiChamberDataPath(['projects', 'p1.json'], deps),
      resolvePiChamberDataPath(['themes', 'a.json'], deps),
      resolvePiChamberDataPath(['quota', 'creds.json'], deps),
      resolvePiChamberDataPath(['pi-session-daemon', 'r.json'], deps),
    ];
    for (const child of children) {
      expect(child.startsWith(root + path.sep)).toBe(true);
    }
  });
});
