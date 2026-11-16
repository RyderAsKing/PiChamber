import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownloadStore, safeFileName } from './downloads.js';

/** A Playwright download that finishes when told to. */
const fakeDownload = ({ url = 'https://files.example/report.pdf', filename = 'report.pdf', body = 'file body' } = {}) => {
  let settle;
  const finished = new Promise((resolve) => { settle = resolve; });
  return {
    url: () => url,
    suggestedFilename: () => filename,
    failure: () => finished,
    saveAs: async (target) => fs.promises.writeFile(target, body),
    delete: async () => {},
    cancel: async () => settle('canceled'),
    finish: (failure = null) => settle(failure),
  };
};

describe('server browser downloads', () => {
  let tmpRoot;
  let serverDownloads;
  let sent;
  let store;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-downloads-test-'));
    serverDownloads = path.join(tmpRoot, 'home', 'Downloads');
    sent = [];
    store = createDownloadStore({
      broadcast: (key, message) => sent.push({ key, ...message }),
      tmpRoot,
      serverDownloadsDir: () => serverDownloads,
    });
  });

  afterEach(async () => {
    await store.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('keeps a finished file under its own name in the temp directory', async () => {
    const download = fakeDownload();
    const done = store.add('tab-a', download);
    expect(sent.at(-1)).toMatchObject({ key: 'tab-a', state: 'inProgress', filename: 'report.pdf', path: null });
    download.finish();
    await done;

    const last = sent.at(-1);
    expect(last).toMatchObject({ state: 'completed', receivedBytes: 9, totalBytes: 9, savedPath: null });
    expect(path.basename(last.path)).toBe('report.pdf');
    expect(last.path.startsWith(tmpRoot)).toBe(true);
    expect(fs.readFileSync(last.path, 'utf8')).toBe('file body');
    expect(fs.statSync(last.path).mode & 0o777).toBe(0o600);
    expect(store.get(last.id)).toEqual({ path: last.path, filename: 'report.pdf' });
  });

  it('reports Chrome progress, whichever of Chrome and Playwright reports first', async () => {
    // Chrome first.
    store.progress('tab-a', { guid: 'g1', url: 'https://files.example/a.zip' });
    store.progress('tab-a', { guid: 'g1', receivedBytes: 10, totalBytes: 100, state: 'inProgress' });
    const first = fakeDownload({ url: 'https://files.example/a.zip', filename: 'a.zip' });
    void store.add('tab-a', first);
    expect(sent.at(-1)).toMatchObject({ filename: 'a.zip', receivedBytes: 10, totalBytes: 100 });

    // Playwright first.
    const second = fakeDownload({ url: 'https://files.example/b.zip', filename: 'b.zip' });
    void store.add('tab-a', second);
    store.progress('tab-a', { guid: 'g2', url: 'https://files.example/b.zip' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    store.progress('tab-a', { guid: 'g2', receivedBytes: 50, totalBytes: 200, state: 'inProgress' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent.filter((m) => m.filename === 'b.zip').at(-1)).toMatchObject({ receivedBytes: 50, totalBytes: 200 });

    // Another tab's download at the same address is not mixed up.
    expect(sent.filter((m) => m.filename === 'a.zip').every((m) => m.key === 'tab-a')).toBe(true);
  });

  it('marks a canceled download canceled and a broken one failed', async () => {
    const canceled = fakeDownload({ filename: 'one.bin' });
    const canceling = store.add('tab-a', canceled);
    const id = sent.at(-1).id;
    expect(await store.cancel(id)).toBe(true);
    await canceling;
    expect(sent.at(-1)).toMatchObject({ id, state: 'canceled', path: null });

    const broken = fakeDownload({ filename: 'two.bin' });
    const breaking = store.add('tab-a', broken);
    broken.finish('net::ERR_FAILED');
    await breaking;
    expect(sent.at(-1)).toMatchObject({ filename: 'two.bin', state: 'failed' });
    expect(store.get(sent.at(-1).id)).toBeNull();
  });

  it('saves a copy to the server Downloads folder, numbering a taken name', async () => {
    fs.mkdirSync(serverDownloads, { recursive: true });
    fs.writeFileSync(path.join(serverDownloads, 'report.pdf'), 'older');
    const download = fakeDownload();
    const done = store.add('tab-a', download);
    download.finish();
    await done;
    const { id } = sent.at(-1);

    const saved = await store.saveToServer(id);
    expect(saved.path).toBe(path.join(serverDownloads, 'report (1).pdf'));
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('file body');
    expect(fs.readFileSync(path.join(serverDownloads, 'report.pdf'), 'utf8')).toBe('older');
    expect(sent.at(-1)).toMatchObject({ id, savedPath: saved.path });
    // Saving again returns the same copy.
    expect(await store.saveToServer(id)).toEqual(saved);
    expect(await store.saveToServer('missing')).toBeNull();
  });

  it('replays a tab\'s downloads and deletes the temp directory on dispose', async () => {
    const download = fakeDownload();
    const done = store.add('tab-a', download);
    void store.add('tab-b', fakeDownload({ filename: 'other.txt' }));
    download.finish();
    await done;
    expect(store.messagesFor('tab-a').map((m) => m.filename)).toEqual(['report.pdf']);
    const file = store.messagesFor('tab-a')[0].path;
    await store.dispose();
    expect(fs.existsSync(path.dirname(path.dirname(file)))).toBe(false);
  });

  it('never names a file . or ..', () => {
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('.')).toBe('file');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a:b?.txt')).toBe('a_b_.txt');
  });

  it('shares one copy between overlapping Save to server calls', async () => {
    const download = fakeDownload();
    const done = store.add('tab-a', download);
    download.finish();
    await done;
    const { id, path: tempPath } = sent.at(-1);

    const [first, second] = await Promise.all([store.saveToServer(id), store.saveToServer(id)]);
    expect(first).toEqual({ path: path.join(serverDownloads, 'report.pdf') });
    expect(second).toEqual(first);
    expect(fs.readdirSync(serverDownloads)).toEqual(['report.pdf']);
    // The temp copy stays for Save to this device.
    expect(fs.existsSync(tempPath)).toBe(true);
  });

  it('tells viewers when an old download is dropped', async () => {
    const first = fakeDownload();
    const firstDone = store.add('tab-a', first);
    first.finish();
    await firstDone;
    const { id: oldestId, path: oldestPath } = sent.at(-1);

    const later = [];
    for (let n = 0; n < 50; n += 1) {
      const download = fakeDownload({ url: `https://files.example/${n}`, filename: `file-${n}.txt` });
      later.push(store.add('tab-a', download));
      download.finish();
    }
    await Promise.all(later);

    expect(sent).toContainEqual({ key: 'tab-a', type: 'download-removed', id: oldestId });
    expect(store.get(oldestId)).toBeNull();
    await expect.poll(() => fs.existsSync(oldestPath)).toBe(false);
  });
});
