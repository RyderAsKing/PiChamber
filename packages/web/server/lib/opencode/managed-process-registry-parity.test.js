import { describe, expect, it } from 'vitest';
import path from 'path';

import {
  resolvePiChamberDataDir as resolveWebDataDir,
  resolvePiChamberDataPath as resolveWebDataPath,
} from '../pichamber-data-dir.js';

describe('managed-process-registry parity', () => {
  it('web resolver derives managed-opencode dir beneath the same data root', () => {
    const deps = { env: {}, homedir: () => '/home/u', path };
    const root = resolveWebDataDir(deps);
    const child = resolveWebDataPath(['managed-opencode'], deps);
    expect(path.dirname(child)).toBe(root);
    expect(child.endsWith(`${path.sep}managed-opencode`)).toBe(true);
  });

  it('honors OPENCHAMBER_DATA_DIR for managed-opencode dir', () => {
    const deps = { env: { OPENCHAMBER_DATA_DIR: '/custom/root' }, homedir: () => '/home/u', path };
    expect(resolveWebDataPath(['managed-opencode'], deps)).toBe(
      path.join('/custom/root', 'managed-opencode'),
    );
  });
});
