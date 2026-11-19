import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { defaultPluginState, isValidStateValue, parsePluginPackage } from './manifest.js';

const packageDir = '/plugins/demo';

const validPackage = (pichamber = {}, extra = {}) => ({
  name: 'demo',
  version: '1.2.3',
  pi: { extensions: ['./extension.js'] },
  ...extra,
  pichamber: {
    apiVersion: 1,
    id: 'demo',
    name: 'Demo',
    description: 'A demo plugin.',
    icon: 'artboard',
    state: {
      on: { type: 'boolean', scope: 'global', default: true, label: 'On' },
      mode: {
        type: 'enum',
        scope: 'project',
        default: 'a',
        label: 'Mode',
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      },
    },
    contributes: {
      composerToggles: [{ id: 'demo', state: 'on', label: 'Demo', icon: 'artboard', description: 'Toggle it' }],
      settings: ['mode'],
      ui: 'demo',
    },
    ...pichamber,
  },
});

const reason = (input, options = { packageDir }) => {
  try {
    parsePluginPackage(input, options);
  } catch (error) {
    expect(error.code).toBe('INVALID_PLUGIN_MANIFEST');
    return error.message;
  }
  throw new Error('expected the manifest to be rejected');
};

describe('parsePluginPackage', () => {
  it('normalizes a valid package', () => {
    const manifest = parsePluginPackage(validPackage(), { packageDir, bundled: true });
    expect(manifest).toMatchObject({
      id: 'demo',
      name: 'Demo',
      version: '1.2.3',
      bundled: true,
      defaultEnabled: false,
      replaceable: false,
      entry: '/plugins/demo/extension.js',
      contributes: {
        composerToggles: [{ id: 'demo', state: 'on', label: 'Demo', icon: 'artboard', description: 'Toggle it' }],
        settings: ['mode'],
        ui: 'demo',
      },
    });
    expect(defaultPluginState(manifest)).toEqual({ on: true, mode: 'a' });
    expect(isValidStateValue(manifest.stateSchema.mode, 'b')).toBe(true);
    expect(isValidStateValue(manifest.stateSchema.mode, 'c')).toBe(false);
    expect(isValidStateValue(manifest.stateSchema.on, 'true')).toBe(false);
  });

  it('parses the bundled Visuals manifest', async () => {
    const dir = fileURLToPath(new URL('../../../plugins/visuals/', import.meta.url));
    const manifest = parsePluginPackage(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), { packageDir: dir, bundled: true });
    expect(manifest.id).toBe('visuals');
    expect(manifest.stateSchema.on).toBeUndefined();
    expect(manifest.stateSchema.allowNetwork).toMatchObject({ default: false, scope: 'global' });
    expect(manifest.contributes.composerToggles).toEqual([]);
    expect(manifest.contributes.settings).toEqual(['allowNetwork']);
  });

  it('keeps package keywords that say what it does', () => {
    const manifest = parsePluginPackage(validPackage({}, {
      keywords: ['pi-package', 'PiChamber', 'Chart', 'chart', '', 7, 'x'.repeat(41), 'diagram'],
    }), { packageDir });
    expect(manifest.packageName).toBe('demo');
    expect(manifest.keywords).toEqual(['chart', 'diagram']);
    expect(parsePluginPackage(validPackage(), { packageDir }).keywords).toEqual([]);
  });

  it('fails closed on invalid fields', () => {
    expect(reason(validPackage({ apiVersion: 2 }))).toMatch(/apiVersion/);
    expect(reason(validPackage({ id: 'Bad_Id' }))).toMatch(/id/);
    expect(reason(validPackage({ id: 'a'.repeat(41) }))).toMatch(/id/);
    expect(reason(validPackage({ icon: 'not an icon' }))).toMatch(/icon/);
    expect(reason(validPackage({ name: '' }))).toMatch(/name/);
    expect(reason(validPackage({ state: { on: { type: 'number', scope: 'global', default: 1, label: 'x' } } }))).toMatch(/type/);
    expect(reason(validPackage({ state: { on: { type: 'boolean', scope: 'session', default: true, label: 'x' } } }))).toMatch(/scope/);
    expect(reason(validPackage({ state: { on: { type: 'boolean', scope: 'global', default: 'yes', label: 'x' } } }))).toMatch(/default/);
    expect(reason(validPackage({ state: { m: { type: 'enum', scope: 'global', default: 'z', label: 'x', options: [{ value: 'a', label: 'A' }] } } }))).toMatch(/default/);
    expect(reason(validPackage({ state: { constructor: { type: 'boolean', scope: 'global', default: true, label: 'x' } } }))).toMatch(/constructor/);
    expect(reason(validPackage({ contributes: { composerToggles: [{ id: 'demo', state: 'mode', label: 'x', icon: 'artboard' }] } }))).toMatch(/boolean/);
    expect(reason(validPackage({ contributes: { settings: ['missing'] } }))).toMatch(/unknown/);
    expect(reason(validPackage({ contributes: { settings: ['mode', 'mode'] } }))).toMatch(/repeats/);
    expect(reason(validPackage({ contributes: { composerToggles: [{ id: 'demo', state: 'on', label: 'Demo', icon: 'artboard' }], settings: ['on'] } }))).toMatch(/composer toggle/);
    expect(reason({ ...validPackage(), version: 'latest' })).toMatch(/version/);
    expect(reason(validPackage({}, {}), { packageDir: 'relative' })).toMatch(/folder/);
  });

  it('keeps the agent half inside the package', () => {
    expect(reason({ ...validPackage(), pi: {} })).toMatch(/pi.extensions/);
    expect(reason({ ...validPackage(), pi: { extensions: ['../other/extension.js'] } })).toMatch(/leaves/);
    expect(reason({ ...validPackage(), pi: { extensions: ['/abs/extension.js'] } })).toMatch(/invalid/);
    expect(reason({ ...validPackage(), pi: { extensions: ['./extension.ts'] } })).toMatch(/JavaScript/);
  });

  it('requires bundled plugins to ship disabled', () => {
    expect(reason(validPackage({ defaultEnabled: true }), { packageDir, bundled: true })).toMatch(/disabled/);
    expect(parsePluginPackage(validPackage({ defaultEnabled: true }), { packageDir }).defaultEnabled).toBe(true);
  });

  it('maps replaceable', () => {
    expect(parsePluginPackage(validPackage({ replaceable: true }), { packageDir }).replaceable).toBe(true);
    expect(reason(validPackage({ replaceable: 'yes' }))).toMatch(/replaceable/);
  });
});
