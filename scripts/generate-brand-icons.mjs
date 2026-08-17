#!/usr/bin/env node
/**
 * Rasterize PiChamber brand SVGs into packaged PNG/ICO/ICNS assets.
 * Usage: bun scripts/generate-brand-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronIcons = path.join(root, 'packages/electron/resources/icons');
const webPublic = path.join(root, 'packages/web/public');

const read = (filePath) => fs.readFileSync(filePath);

const recolorSvg = (svg, color) => Buffer.from(String(svg).replaceAll('currentColor', color));

const png = async (svg, size, { background } = {}) => {
  let image = sharp(Buffer.isBuffer(svg) ? svg : Buffer.from(svg));
  if (background) image = image.flatten({ background });
  return image.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
};

const encodeIco = (images) => {
  const headerSize = 6 + (16 * images.length);
  let offset = headerSize;
  const entries = images.map((buf) => {
    const entry = { buf, offset, size: buf.length };
    offset += buf.length;
    return entry;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(images.length, 4);
  let dir = 6;
  for (const [index, entry] of entries.entries()) {
    const size = [16, 24, 32, 48, 64, 128, 256][index];
    out[dir] = size === 256 ? 0 : size;
    out[dir + 1] = size === 256 ? 0 : size;
    out[dir + 2] = 0;
    out[dir + 3] = 0;
    out.writeUInt16LE(1, dir + 4);
    out.writeUInt16LE(32, dir + 6);
    out.writeUInt32LE(entry.size, dir + 8);
    out.writeUInt32LE(entry.offset, dir + 12);
    dir += 16;
    entry.buf.copy(out, entry.offset);
  }
  return out;
};

const encodeIcns = (chunks) => {
  const payload = Buffer.concat(chunks.flatMap(({ type, data }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return [header, data];
  }));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
};

const write = (filePath, data) => {
  fs.writeFileSync(filePath, data);
  console.log(`wrote ${path.relative(root, filePath)}`);
};

const appIconSvg = read(path.join(electronIcons, 'app-icon.svg'));
const winIconSvg = read(path.join(electronIcons, 'icon-win.svg'));
const glyphSvg = read(path.join(electronIcons, 'app-icon-glyph.svg'));
const traySvg = read(path.join(electronIcons, 'tray/tray-glyph.svg'));
const faviconSvg = read(path.join(webPublic, 'favicon.svg'));
const appleSvg = read(path.join(webPublic, 'apple-touch-icon.svg'));
const logoDarkSvg = read(path.join(webPublic, 'logo-dark-512x512.svg'));
const logoLightSvg = read(path.join(webPublic, 'logo-light-512x512.svg'));

const iconPng = await png(appIconSvg, 1024);
write(path.join(electronIcons, 'icon.png'), iconPng);
write(path.join(electronIcons, 'dev-icon.png'), iconPng);
write(path.join(electronIcons, 'app-icon.png'), await png(appIconSvg, 512));

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
write(path.join(electronIcons, 'icon.ico'), encodeIco(await Promise.all(icoSizes.map((size) => png(winIconSvg, size)))));

const icnsChunks = [];
for (const [type, size] of [
  ['icp4', 16], ['icp5', 32], ['icp6', 64],
  ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
]) {
  icnsChunks.push({ type, data: await png(appIconSvg, size) });
}
write(path.join(electronIcons, 'icon.icns'), encodeIcns(icnsChunks));
write(path.join(electronIcons, 'dev-icon.icns'), encodeIcns(icnsChunks));

const darkGlyph = await png(recolorSvg(glyphSvg, '#ffffff'), 1024);
const lightGlyph = await png(recolorSvg(glyphSvg, '#000000'), 1024);
write(path.join(electronIcons, 'AppIcon.icon/Assets/app-icon-glyph-dark 4.png'), darkGlyph);
write(path.join(electronIcons, 'AppIcon.icon/Assets/app-icon-glyph-light 2.png'), lightGlyph);

const trayIdle = await png(traySvg, 18);
const trayIdle2x = await png(traySvg, 36);
const trayDir = path.join(electronIcons, 'tray');
write(path.join(trayDir, 'trayTemplate-idle.png'), trayIdle);
write(path.join(trayDir, 'trayTemplate-idle@2x.png'), trayIdle2x);
write(path.join(trayDir, 'trayTemplate-unseen.png'), trayIdle);
write(path.join(trayDir, 'trayTemplate-unseen@2x.png'), trayIdle2x);
for (let frame = 0; frame <= 15; frame += 1) {
  const padded = String(frame).padStart(2, '0');
  write(path.join(trayDir, `trayTemplate-breath-${padded}.png`), trayIdle);
  write(path.join(trayDir, `trayTemplate-breath-${padded}@2x.png`), trayIdle2x);
}

write(path.join(webPublic, 'favicon-16.png'), await png(faviconSvg, 16));
write(path.join(webPublic, 'favicon-32.png'), await png(faviconSvg, 32));
write(path.join(webPublic, 'favicon.png'), await png(faviconSvg, 48));
for (const size of [120, 152, 167, 180]) {
  write(path.join(webPublic, `apple-touch-icon-${size}x${size}.png`), await png(appleSvg, size));
}
write(path.join(webPublic, 'apple-touch-icon.png'), await png(appleSvg, 180));
write(path.join(webPublic, 'logo-dark-192x192.png'), await png(logoDarkSvg, 192));
write(path.join(webPublic, 'logo-light-192x192.png'), await png(logoLightSvg, 192));
write(path.join(webPublic, 'pwa-192.png'), await png(logoDarkSvg, 192));
write(path.join(webPublic, 'pwa-512.png'), await png(logoDarkSvg, 512));
write(path.join(webPublic, 'pwa-maskable-192.png'), await png(logoDarkSvg, 192, { background: '#141414' }));
write(path.join(webPublic, 'pwa-maskable-512.png'), await png(logoDarkSvg, 512, { background: '#141414' }));
