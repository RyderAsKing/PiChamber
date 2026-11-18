import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { registerWallpaperRoutes } from './routes.js';
import { MAX_WALLPAPER_IMAGE_BYTES, createWallpaperImageStore, sniffImageType } from './store.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

describe('wallpaper image', () => {
  let server;
  let dataDir;

  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    server = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const setup = async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pc-wallpaper-'));
    const app = express();
    // The server parses JSON bodies for every route; an image must pass through.
    app.use(express.json());
    const store = createWallpaperImageStore({ dataDir });
    registerWallpaperRoutes(app, { express, store });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/wallpaper-image`;
    return { base, store };
  };

  it('knows PNG, JPEG and WebP by their bytes only', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
  });

  it('has no picture until one is saved, then serves it with its version', async () => {
    const { base } = await setup();
    expect((await fetch(base)).status).toBe(404);

    const put = await fetch(base, { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: WEBP });
    expect(put.status).toBe(200);
    const saved = await put.json();
    expect(saved.type).toBe('image/webp');
    expect(saved.version).toMatch(/^[0-9a-f]{16}$/);

    const get = await fetch(base);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/webp');
    expect(get.headers.get('x-wallpaper-version')).toBe(saved.version);
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await get.arrayBuffer()).equals(WEBP)).toBe(true);
  });

  it('types the picture by its bytes, not the request header', async () => {
    const { base } = await setup();
    const put = await fetch(base, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: PNG });
    expect((await put.json()).type).toBe('image/png');
    expect((await fetch(base)).headers.get('content-type')).toBe('image/png');
  });

  it('refuses other files and keeps the picture it had', async () => {
    const { base } = await setup();
    await fetch(base, { method: 'PUT', body: JPEG });
    const svg = await fetch(base, { method: 'PUT', headers: { 'content-type': 'image/svg+xml' }, body: '<svg onload="alert(1)"/>' });
    expect(svg.status).toBe(415);
    const empty = await fetch(base, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: '' });
    expect(empty.status).toBe(415);
    expect((await fetch(base)).headers.get('content-type')).toBe('image/jpeg');
  });

  it('refuses pictures over the size limit', async () => {
    const { base } = await setup();
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_WALLPAPER_IMAGE_BYTES)]);
    const put = await fetch(base, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: big });
    expect(put.status).toBe(413);
    expect((await fetch(base)).status).toBe(404);
  });

  it('removes the picture', async () => {
    const { base } = await setup();
    await fetch(base, { method: 'PUT', body: PNG });
    expect((await fetch(base, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(base)).status).toBe(404);
    expect((await fetch(base, { method: 'DELETE' })).status).toBe(204);
  });

  it('reads a damaged or mismatched record as no picture', async () => {
    const { base, store } = await setup();
    await store.write(PNG);
    await writeFile(join(dataDir, 'wallpaper', 'image'), JPEG);
    expect((await fetch(base)).status).toBe(404);
    await writeFile(join(dataDir, 'wallpaper', 'image.json'), '{not json');
    expect(await store.read()).toBeNull();
  });
});
