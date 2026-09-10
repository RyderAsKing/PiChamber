import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeDirectoryPath } from './host.js';

describe('workspace directory normalization', () => {
  it('expands the global-session home sentinel', () => {
    expect(normalizeDirectoryPath('~')).toBe(path.resolve(os.homedir()));
  });

  it('keeps ordinary path resolution behavior', () => {
    expect(normalizeDirectoryPath('./workspace')).toBe(path.resolve('./workspace'));
  });
});
