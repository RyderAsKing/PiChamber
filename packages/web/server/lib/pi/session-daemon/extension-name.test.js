import { describe, expect, it } from 'vitest';
import { deriveExtensionName, resolveExtensionName } from './extension-name.js';

describe('deriveExtensionName', () => {
  it('names a PiChamber plugin factory like a Pi built-in', () => {
    expect(deriveExtensionName('<inline:pichamber:visuals>')).toBe('pichamber:visuals');
    expect(deriveExtensionName('<inline:other>')).toBe('<inline:other>');
  });

  it('derives single-file extension name without sourceInfo', () => {
    expect(deriveExtensionName('/home/u/.pi/agent/extensions/modes.ts')).toBe('modes');
  });

  it('derives directory extension name using ancestor directory when sourceInfo is provided', () => {
    expect(
      deriveExtensionName('/home/u/.pi/agent/extensions/browser/index.ts', {
        source: 'auto',
        origin: 'top-level',
        scope: 'user',
        baseDir: '/home/u/.pi/agent',
      })
    ).toBe('browser');
  });

  it('derives directory extension name without sourceInfo', () => {
    expect(deriveExtensionName('/home/u/.pi/agent/extensions/web-search/index.js')).toBe('web-search');
  });

  it('skips generic directories like src when looking for ancestor directory name', () => {
    expect(
      deriveExtensionName('/home/u/.pi/agent/extensions/foo/src/index.ts', {
        origin: 'top-level',
        source: 'auto',
        baseDir: '/home/u/.pi/agent',
      })
    ).toBe('foo');
  });

  it('falls back to index when stopping at baseDir for top-level origin', () => {
    expect(
      deriveExtensionName('/home/u/.pi/agent/extensions/index.ts', {
        origin: 'top-level',
        source: 'auto',
        baseDir: '/home/u/.pi/agent',
      })
    ).toBe('index');
  });

  it('derives package root directory name for package origin when stopping at baseDir', () => {
    expect(
      deriveExtensionName('/x/npm/node_modules/@scope/pkg/dist/index.js', {
        origin: 'package',
        source: 'npm:@scope/pkg',
        baseDir: '/x/npm/node_modules/@scope/pkg',
      })
    ).toBe('pkg');
  });

  it('derives non-index extension name inside a package', () => {
    expect(
      deriveExtensionName('/x/npm/node_modules/pkg/extensions/alpha.ts', {
        origin: 'package',
        baseDir: '/x/npm/node_modules/pkg',
      })
    ).toBe('alpha');
  });

  it('derives directory extension name inside a package', () => {
    expect(
      deriveExtensionName('/x/npm/node_modules/pkg/extensions/beta/index.ts', {
        origin: 'package',
        baseDir: '/x/npm/node_modules/pkg',
      })
    ).toBe('beta');
  });

  it('derives package name for root index.mjs', () => {
    expect(
      deriveExtensionName('/x/pkg/index.mjs', {
        origin: 'package',
        baseDir: '/x/pkg',
      })
    ).toBe('pkg');
  });

  it('preserves synthetic inline labels', () => {
    expect(deriveExtensionName('<inline:1>')).toBe('<inline:1>');
  });

  it('returns unknown for undefined or empty string', () => {
    expect(deriveExtensionName(undefined)).toBe('unknown');
    expect(deriveExtensionName('')).toBe('unknown');
    expect(deriveExtensionName(null)).toBe('unknown');
  });

  it('sanitizes slashes, backslashes, and bounds length to 256 characters', () => {
    const withSlashes = deriveExtensionName('custom/path/with\\slash/plugin.ts');
    expect(withSlashes).not.toContain('/');
    expect(withSlashes).not.toContain('\\');
    expect(withSlashes).toBe('plugin');

    const longStem = 'a'.repeat(300) + '.ts';
    const longDerived = deriveExtensionName(longStem);
    expect(longDerived.length).toBe(256);
    expect(longDerived).toBe('a'.repeat(256));
  });
});

describe('resolveExtensionName', () => {
  it('resolves package extension name from matching session resourceLoader metadata', () => {
    const fakeSession = {
      resourceLoader: {
        getExtensions: () => ({
          extensions: [
            {
              path: '/x/npm/node_modules/@scope/pkg/dist/index.js',
              sourceInfo: {
                origin: 'package',
                source: 'npm:@scope/pkg',
                baseDir: '/x/npm/node_modules/@scope/pkg',
              },
            },
          ],
        }),
      },
    };

    expect(resolveExtensionName(fakeSession, '/x/npm/node_modules/@scope/pkg/dist/index.js')).toBe('pkg');
  });

  it('falls back to path-only derivation when session has no resourceLoader', () => {
    const fakeSession = {};
    expect(resolveExtensionName(fakeSession, '/home/u/.pi/agent/extensions/modes.ts')).toBe('modes');
    expect(resolveExtensionName(null, '/home/u/.pi/agent/extensions/modes.ts')).toBe('modes');
  });

  it('falls back to path-only derivation when resourceLoader.getExtensions throws', () => {
    const fakeSession = {
      resourceLoader: {
        getExtensions: () => {
          throw new Error('boom');
        },
      },
    };

    expect(resolveExtensionName(fakeSession, '/home/u/.pi/agent/extensions/modes.ts')).toBe('modes');
  });
});
