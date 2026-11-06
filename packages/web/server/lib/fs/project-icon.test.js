import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectIconResolver, findDeclaredIconHref } from './project-icon.js';

let root;

const write = async (relative, content = 'icon') => {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
};

const createResolver = (options = {}) => createProjectIconResolver({ fsPromises: fs, path, ...options });

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-icon-')));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('findDeclaredIconHref', () => {
  it('reads the href of an icon link in HTML', () => {
    const html = '<link rel="stylesheet" href="/app.css"><link href="/brand.svg" rel="shortcut icon">';
    expect(findDeclaredIconHref(html)).toBe('/brand.svg');
  });

  it('reads an icon from a framework head config', () => {
    const source = "links: [{ rel: 'stylesheet', href: '/app.css' }, { rel: 'icon', href: '/logo.png' }]";
    expect(findDeclaredIconHref(source)).toBe('/logo.png');
  });

  it('ignores apple-touch-icon-only and missing declarations', () => {
    expect(findDeclaredIconHref('<link rel="apple-touch-icon-precomposed" href="/a.png">')).toBeNull();
    expect(findDeclaredIconHref('<html></html>')).toBeNull();
  });
});

describe('createProjectIconResolver', () => {
  it('returns null for a project without an icon', async () => {
    await write('README.md', '# hi');
    expect(await createResolver().resolve(root)).toBeNull();
  });

  it('prefers a root favicon over later candidates', async () => {
    await write('public/favicon.ico');
    const svg = await write('favicon.svg', '<svg/>');
    expect(await createResolver().resolve(root)).toEqual({ path: svg, mime: 'image/svg+xml' });
  });

  it('finds an app-router icon', async () => {
    const icon = await write('src/app/favicon.ico');
    expect(await createResolver().resolve(root)).toEqual({ path: icon, mime: 'image/x-icon' });
  });

  it('follows an icon declared in index.html', async () => {
    await write('index.html', '<head><link rel="icon" type="image/png" href="/brand/mark.png?v=2"></head>');
    const icon = await write('public/brand/mark.png');
    expect(await createResolver().resolve(root)).toEqual({ path: icon, mime: 'image/png' });
  });

  it('skips remote and data-URL declarations', async () => {
    await write('index.html', '<link rel="icon" href="https://cdn.example.com/icon.png">');
    expect(await createResolver().resolve(root)).toBeNull();
  });

  it('searches monorepo packages, preferring the web package', async () => {
    await write('packages/docs/public/favicon.ico');
    const web = await write('packages/web/public/favicon.svg', '<svg/>');
    expect(await createResolver().resolve(root)).toEqual({ path: web, mime: 'image/svg+xml' });
  });

  it('never returns a file outside the project, even through a symlink', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'project-icon-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'favicon.ico'), 'icon');
      await fs.symlink(path.join(outside, 'favicon.ico'), path.join(root, 'favicon.ico'));
      await write('index.html', '<link rel="icon" href="../../etc/passwd.png">');
      expect(await createResolver().resolve(root)).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects icons that are empty or too large', async () => {
    await write('favicon.ico', '');
    await write('favicon.png', Buffer.alloc(1024 * 1024 + 1));
    expect(await createResolver().resolve(root)).toBeNull();
  });

  it('re-resolves when a cached icon disappears', async () => {
    const resolver = createResolver();
    const svg = await write('favicon.svg', '<svg/>');
    const png = await write('public/favicon.png');
    expect((await resolver.resolve(root))?.path).toBe(svg);
    await fs.rm(svg);
    expect((await resolver.resolve(root))?.path).toBe(png);
  });

  it('caches a missing icon briefly, then looks again', async () => {
    let time = 0;
    const resolver = createResolver({ now: () => time });
    expect(await resolver.resolve(root)).toBeNull();
    const icon = await write('favicon.png');
    expect(await resolver.resolve(root)).toBeNull();
    time += 61 * 1000;
    expect((await resolver.resolve(root))?.path).toBe(icon);
  });
});
