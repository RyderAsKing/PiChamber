#!/usr/bin/env node
/**
 * Rasterize PiChamber brand SVGs into packaged PNG/ICO/ICNS assets
 * for desktop, web, and mobile launcher/splash images.
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

const BRAND_BG = { r: 20, g: 20, b: 20, alpha: 1 };

const png = async (svg, size, { background } = {}) => {
  let image = sharp(Buffer.isBuffer(svg) ? svg : Buffer.from(svg));
  if (background) image = image.flatten({ background });
  return image.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
};

const solidPng = async (width, height, background = BRAND_BG) =>
  sharp({
    create: { width, height, channels: 4, background },
  }).png().toBuffer();

const compositeCentered = async (width, height, overlay, background = BRAND_BG) =>
  sharp({
    create: { width, height, channels: 4, background },
  }).composite([{ input: overlay, gravity: 'centre' }]).png().toBuffer();

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

const mobileDir = path.join(root, 'packages/mobile');
const mobileAssets = path.join(mobileDir, 'assets');
const androidRes = path.join(mobileDir, 'android/app/src/main/res');
const iosAppAssets = path.join(mobileDir, 'ios/App/App/Assets.xcassets');
const whiteGlyph = recolorSvg(glyphSvg, '#ffffff');
const iconForeground = await png(whiteGlyph, 1024);
const iconOnly = await compositeCentered(1024, 1024, await png(whiteGlyph, 680));

write(path.join(mobileAssets, 'icon-foreground.png'), iconForeground);
write(path.join(mobileAssets, 'icon-background.png'), await solidPng(1024, 1024));
write(path.join(mobileAssets, 'icon-only.png'), iconOnly);
write(path.join(iosAppAssets, 'AppIcon.appiconset/AppIcon-512@2x.png'), iconOnly);

for (const [density, size] of [
  ['ldpi', 36],
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]) {
  const dir = path.join(androidRes, `mipmap-${density}`);
  const launcher = await compositeCentered(size, size, await png(whiteGlyph, Math.round(size * 0.66)));
  write(path.join(dir, 'ic_launcher.png'), launcher);
  write(path.join(dir, 'ic_launcher_round.png'), launcher);
  write(path.join(dir, 'ic_launcher_foreground.png'), await png(whiteGlyph, size));
  write(path.join(dir, 'ic_launcher_background.png'), await solidPng(size, size));
}

const writeSplash = async (filePath, width, height) => {
  const logoSize = Math.round(Math.min(width, height) * 0.28);
  write(filePath, await compositeCentered(width, height, await png(whiteGlyph, logoSize)));
};

await writeSplash(path.join(androidRes, 'drawable/splash.png'), 480, 320);
for (const [folder, width, height] of [
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
]) {
  await writeSplash(path.join(androidRes, folder, 'splash.png'), width, height);
}

const iosSplash = await compositeCentered(2732, 2732, await png(whiteGlyph, 760));
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  write(path.join(iosAppAssets, 'Splash.imageset', name), iosSplash);
}
