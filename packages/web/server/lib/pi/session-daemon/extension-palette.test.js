import { describe, expect, it } from 'vitest';

import { createExtensionPaletteResolver, isTerminalColors } from './extension-palette.js';

const LIGHT_TERMINAL = {
  background: '#fffcf0',
  foreground: '#100f0f',
  palette: [
    '#100f0f', '#af3029', '#66800b', '#ad8301', '#205ea6', '#a02f6f', '#24837b', '#f2f0e5',
    '#575653', '#d14d41', '#879a39', '#d0a215', '#4385be', '#ce5d97', '#3aa99f', '#fffcf0',
  ],
};
const DARK_TERMINAL = { ...LIGHT_TERMINAL, background: '#100f0f', foreground: '#cecdc3' };

// These run against the installed Pi, so a Pi update that moves its theme
// modules fails here rather than silently in the app.
describe('extension palette', () => {
  const resolve = createExtensionPaletteResolver();

  it('generates the system theme from the terminal colours by default', async () => {
    const light = await resolve({ themeSetting: undefined, terminal: LIGHT_TERMINAL });
    expect(light.theme).toBe('system');
    expect(light.appearance).toBe('light');
    expect(light.background).toBeUndefined();
    expect(light.colors.accent).toMatch(/^#[0-9a-f]{6}$/);
    for (const color of Object.values(light.colors)) expect(color).toMatch(/^#[0-9a-f]{6}$/);

    const dark = await resolve({ themeSetting: undefined, terminal: DARK_TERMINAL });
    expect(dark.appearance).toBe('dark');
    expect(dark.colors.accent).not.toBe(light.colors.accent);
  });

  it("uses a named theme's own colours and page background", async () => {
    const dark = await resolve({ themeSetting: 'dark', terminal: LIGHT_TERMINAL });
    expect(dark).toMatchObject({ theme: 'dark', appearance: 'dark', background: '#21252c' });
    expect(dark.colors.accent).toBe('#a798d7');
  });

  it('picks from a light/dark pair by the terminal appearance', async () => {
    expect(await resolve({ themeSetting: 'light/dark', terminal: LIGHT_TERMINAL })).toMatchObject({ theme: 'light', appearance: 'light' });
    expect(await resolve({ themeSetting: 'light/dark', terminal: DARK_TERMINAL })).toMatchObject({ theme: 'dark', appearance: 'dark' });
  });

  it('falls back to the system theme for an unknown theme', async () => {
    expect((await resolve({ themeSetting: 'no-such-theme', terminal: LIGHT_TERMINAL })).theme).toBe('system');
  });

  it('rejects invalid terminal colours', async () => {
    expect(isTerminalColors(LIGHT_TERMINAL)).toBe(true);
    for (const terminal of [null, { ...LIGHT_TERMINAL, background: 'red' }, { ...LIGHT_TERMINAL, palette: LIGHT_TERMINAL.palette.slice(1) }]) {
      expect(isTerminalColors(terminal)).toBe(false);
      await expect(resolve({ terminal })).rejects.toThrow(TypeError);
    }
  });

  it('reports a failed load and tries again on the next request', async () => {
    let attempts = 0;
    const failing = createExtensionPaletteResolver({
      loadModules: async () => {
        attempts += 1;
        throw new Error('moved');
      },
    });
    await expect(failing({ terminal: LIGHT_TERMINAL })).rejects.toThrow('moved');
    await expect(failing({ terminal: LIGHT_TERMINAL })).rejects.toThrow('moved');
    expect(attempts).toBe(2);
  });
});
