import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let cached;

const platformPackage = () => `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const loaderKey = () => process.platform === 'linux' ? 'LD_LIBRARY_PATH' : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : process.platform === 'win32' ? 'PATH' : null;

function resolveLibraryDirectory() {
  try {
    const directory = path.dirname(require.resolve(`${platformPackage()}/package.json`));
    const unpacked = directory.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return existsSync(unpacked) ? unpacked : directory;
  } catch { return null; }
}

export function applySherpaLoaderEnv(env) {
  const key = loaderKey();
  const directory = resolveLibraryDirectory();
  if (!key || !directory) return;
  const actualKey = Object.keys(env).find((entry) => entry.toLowerCase() === key.toLowerCase()) ?? key;
  const values = String(env[actualKey] || '').split(path.delimiter).filter(Boolean);
  if (!values.includes(directory)) env[actualKey] = [directory, ...values].join(path.delimiter);
}

export function loadSherpaOnnxNode() {
  if (cached) return cached;
  try { cached = require('sherpa-onnx-node'); return cached; }
  catch (firstError) {
    const directory = resolveLibraryDirectory();
    if (directory) {
      applySherpaLoaderEnv(process.env);
      const addon = path.join(directory, 'sherpa-onnx.node');
      if (existsSync(addon)) {
        try { cached = require(addon); return cached; }
        catch { /* report the original package failure below */ }
      }
    }
    throw new Error(`Failed to load sherpa-onnx-node for ${process.platform}-${process.arch}: ${firstError?.message || firstError}`);
  }
}
