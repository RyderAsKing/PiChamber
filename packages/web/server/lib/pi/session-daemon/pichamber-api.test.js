import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { PICHAMBER_API, PICHAMBER_API_FUNCTIONS, PICHAMBER_API_VERSION, createPichamberApi } from './pichamber-api.js';

describe('the pichamber API object', () => {
  it('routes every function to the session behind ctx', async () => {
    const api = createPichamberApi();
    const calls = [];
    const ctx = { ui: { [PICHAMBER_API]: Object.fromEntries(PICHAMBER_API_FUNCTIONS.map((name) => [name, (...args) => { calls.push([name, ...args]); return name; }])) } };
    for (const name of PICHAMBER_API_FUNCTIONS) await expect(api[name](ctx, 'a', 'b')).resolves.toBe(name);
    expect(calls).toEqual(PICHAMBER_API_FUNCTIONS.map((name) => [name, 'a', 'b']));
    await expect(api.card({ ui: {} }, {})).rejects.toThrow(/pichamber\.card needs the tool or handler `ctx`/);
  });

  // Authors read `pichamber.d.ts`; it must name what the object really has.
  it('is declared in full by pichamber.d.ts', async () => {
    const types = await readFile(new URL('../../../../pichamber.d.ts', import.meta.url), 'utf8');
    const declared = types.slice(types.indexOf('export interface PiChamber {'), types.indexOf('declare global'));
    const members = [...declared.matchAll(/^ {2}(?:readonly )?(\w+)[(:]/gm)].map((match) => match[1]).sort();
    expect(members).toEqual(Object.keys(createPichamberApi()).sort());
    expect(declared).toContain(`readonly apiVersion: ${PICHAMBER_API_VERSION};`);
  });
});
