import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveExtensionMode } from './extension-ui-mode.js';

const dataDirWith = async (contents) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-extension-ui-'));
  if (contents !== undefined) {
    await mkdir(join(dataDir, 'pi'), { recursive: true });
    await writeFile(join(dataDir, 'pi', 'settings.json'), contents);
  }
  return dataDir;
};

describe('resolveExtensionMode', () => {
  it('reports the terminal UI when nothing is set', async () => {
    expect(resolveExtensionMode({ dataDir: await dataDirWith(undefined) })).toBe('tui');
    expect(resolveExtensionMode({ dataDir: await dataDirWith('{"version":1}') })).toBe('tui');
    expect(resolveExtensionMode({})).toBe('tui');
  });

  it('maps the two settings to Pi modes', async () => {
    expect(resolveExtensionMode({ dataDir: await dataDirWith('{"version":1,"extensionUi":"dialogs"}') })).toBe('rpc');
    expect(resolveExtensionMode({ dataDir: await dataDirWith('{"version":1,"extensionUi":"terminal"}') })).toBe('tui');
  });

  it('keeps the default for an unreadable file or an unknown value', async () => {
    expect(resolveExtensionMode({ dataDir: await dataDirWith('{not json') })).toBe('tui');
    expect(resolveExtensionMode({ dataDir: await dataDirWith('{"extensionUi":"rpc"}') })).toBe('tui');
  });
});
