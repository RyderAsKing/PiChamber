import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

import { getLocalSttModelDir, getLocalSttModelSpec } from './model-catalog.js';
import { sha256File } from '../audio.js';

const MANIFEST_FILE = '.pichamber-stt-model.json';
const MIN_FREE_BYTES_AFTER_DOWNLOAD = 512 * 1024 * 1024;

async function readManifest(modelDir) {
  try { return JSON.parse(await readFile(path.join(modelDir, MANIFEST_FILE), 'utf8')); }
  catch { return null; }
}

async function fileSnapshot(modelDir, relativePath) {
  const fullPath = path.join(modelDir, relativePath);
  const info = await stat(fullPath);
  if (!info.isFile() || info.size <= 0) throw new Error(`Missing model file: ${relativePath}`);
  return { path: relativePath, size: info.size, sha256: await sha256File(fullPath) };
}

export async function inspectLocalSttModel(modelsDir, modelId, { verifyChecksums = false } = {}) {
  const spec = getLocalSttModelSpec(modelId);
  const modelDir = getLocalSttModelDir(modelsDir, modelId);
  try {
    const manifest = await readManifest(modelDir);
    if (!manifest || manifest.modelId !== modelId || manifest.archiveSha256 !== spec.sha256 || !Array.isArray(manifest.files)) {
      return { installed: false, corrupt: Boolean(manifest) };
    }
    const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
    for (const relativePath of spec.requiredFiles) {
      const entry = expected.get(relativePath);
      if (!entry) return { installed: false, corrupt: true };
      const fullPath = path.join(modelDir, relativePath);
      const info = await stat(fullPath);
      if (!info.isFile() || info.size !== entry.size) return { installed: false, corrupt: true };
      if (verifyChecksums && await sha256File(fullPath) !== entry.sha256) return { installed: false, corrupt: true };
    }
    return { installed: true, corrupt: false };
  } catch {
    return { installed: false, corrupt: true };
  }
}

async function assertDiskSpace(modelsDir, archiveBytes) {
  await mkdir(modelsDir, { recursive: true, mode: 0o700 });
  if (typeof statfs !== 'function') return;
  const info = await statfs(modelsDir);
  const free = Number(info.bavail) * Number(info.bsize);
  const required = archiveBytes * 2 + MIN_FREE_BYTES_AFTER_DOWNLOAD;
  if (Number.isFinite(free) && free < required) throw new Error(`Not enough disk space. At least ${Math.ceil(required / 1024 / 1024)} MB free is required.`);
}

async function downloadArchive(spec, archivePath, onProgress, signal) {
  const temporary = `${archivePath}.tmp-${randomUUID()}`;
  const response = await fetch(spec.archiveUrl, { redirect: 'follow', signal });
  if (!response.ok || !response.body) throw new Error(`Model download failed with HTTP ${response.status}`);
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength !== spec.sizeBytes) throw new Error('Model archive size did not match the pinned catalog');
  let downloaded = 0;
  const stream = Readable.fromWeb(response.body);
  stream.on('data', (chunk) => {
    downloaded += chunk.byteLength;
    onProgress?.(downloaded, spec.sizeBytes);
  });
  try {
    await pipeline(stream, createWriteStream(temporary, { mode: 0o600 }));
    if (downloaded !== spec.sizeBytes) throw new Error('Model archive download was incomplete');
    if (await sha256File(temporary) !== spec.sha256) throw new Error('Model archive checksum verification failed');
    await rename(temporary, archivePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function extractArchive(archivePath, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['xf', archivePath, '-C', destination], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Model extraction failed with exit code ${code}`)));
  });
}

export async function ensureLocalSttModel({ modelsDir, modelId, onProgress, signal }) {
  const spec = getLocalSttModelSpec(modelId);
  const modelDir = getLocalSttModelDir(modelsDir, modelId);
  const inspection = await inspectLocalSttModel(modelsDir, modelId);
  if (inspection.installed) return modelDir;
  await rm(modelDir, { recursive: true, force: true });
  await assertDiskSpace(modelsDir, spec.sizeBytes);

  const downloadsDir = path.join(modelsDir, '.downloads');
  await mkdir(downloadsDir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(downloadsDir, `${modelId}-${spec.sha256}.tar.bz2`);
  try {
    const archiveInfo = await stat(archivePath).catch(() => null);
    if (!archiveInfo || archiveInfo.size !== spec.sizeBytes || await sha256File(archivePath) !== spec.sha256) {
      await rm(archivePath, { force: true });
      await downloadArchive(spec, archivePath, onProgress, signal);
    }

    const stagingRoot = path.join(modelsDir, `.staging-${modelId}-${randomUUID()}`);
    try {
      await extractArchive(archivePath, stagingRoot);
      const stagedModelDir = path.join(stagingRoot, spec.extractedDir);
      const files = [];
      for (const relativePath of spec.requiredFiles) files.push(await fileSnapshot(stagedModelDir, relativePath));
      await writeFile(path.join(stagedModelDir, MANIFEST_FILE), `${JSON.stringify({ version: 1, modelId, archiveSha256: spec.sha256, files }, null, 2)}\n`, { mode: 0o600 });
      await rename(stagedModelDir, modelDir);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    await rm(archivePath, { force: true });
    return modelDir;
  } catch (error) {
    await rm(archivePath, { force: true }).catch(() => {});
    await rm(modelDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
