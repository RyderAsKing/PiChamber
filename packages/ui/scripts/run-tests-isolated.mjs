#!/usr/bin/env node
/**
 * Runs every `*.test.{ts,tsx}` file in this package in its own `bun test`
 * process.
 *
 * Why per-file isolation: `bun:test`'s `mock.module()` registrations are
 * process-global and cannot be un-registered, so a full-suite single-process
 * run lets mocks leak across files (a partial mock of `@/lib/runtime-switch`
 * in one file breaks every later file importing the real module). Several
 * suites also document this constraint ("lives in its own file because module
 * state is shared across tests within a file"). Isolating each file restores
 * deterministic results regardless of directory ordering.
 *
 * Usage: node scripts/run-tests-isolated.mjs [pattern ...]
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const collectTestFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectTestFiles(fullPath, out);
    } else if (/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
};

const args = process.argv.slice(2);
let files = collectTestFiles(path.join(packageRoot, 'src')).sort();
if (args.length > 0) {
  files = files.filter((file) => args.some((pattern) => file.includes(pattern)));
}
if (files.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

const concurrency = Math.max(1, Math.min(8, os.cpus().length));
const failed = [];
let completed = 0;

const runOne = (file) => new Promise((resolve) => {
  // `bun test` resolves bunfig/tsconfig paths from the working directory.
  const child = spawn('bun', ['test', file], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => {
    // Bound retained output so a chatty failure cannot exhaust memory.
    if (output.length < 16_000) output += chunk.toString('utf8');
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('close', (code) => {
    completed += 1;
    if (code !== 0) {
      failed.push({ file, code, output });
      console.error(`FAIL (${completed}/${files.length}) ${path.relative(packageRoot, file)}`);
    } else {
      console.log(`ok   (${completed}/${files.length}) ${path.relative(packageRoot, file)}`);
    }
    resolve();
  });
});

const queue = [...files];
const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (;;) {
    const file = queue.shift();
    if (!file) return;
    await runOne(file);
  }
});
await Promise.all(workers);

console.log('');
console.log(`${files.length - failed.length}/${files.length} test files passed.`);

for (const { file, output } of failed) {
  console.error('');
  console.error(`--- FAIL: ${path.relative(packageRoot, file)} ---`);
  const lines = output.split('\n');
  // Skip the runner banner; keep the failure details at the tail where bun prints them.
  const relevant = lines.filter((line) => line.trim().length > 0).slice(-40);
  console.error(relevant.join('\n'));
}

process.exit(failed.length > 0 ? 1 : 0);
