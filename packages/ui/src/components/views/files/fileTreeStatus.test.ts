import { describe, expect, test } from 'bun:test';

import {
  classifyGitFileStatus,
  createExpansionSet,
  createFileTreeStatusIndex,
  toRootRelativePath,
  type GitStatusFile,
} from './fileTreeStatus';

const ROOT = '/repo';

const file = (path: string, index: string, working_dir: string): GitStatusFile => ({
  path,
  index,
  working_dir,
});

describe('toRootRelativePath', () => {
  test('converts children, passes through outsiders and sibling prefixes', () => {
    expect(toRootRelativePath(`${ROOT}/a.ts`, ROOT)).toBe('a.ts');
    expect(toRootRelativePath(`${ROOT}/a/b.ts`, ROOT)).toBe('a/b.ts');
    expect(toRootRelativePath('/other/file.ts', ROOT)).toBe('/other/file.ts');
    expect(toRootRelativePath(ROOT, ROOT)).toBe(ROOT);
    expect(toRootRelativePath('/repo2/x.ts', ROOT)).toBe('/repo2/x.ts');
  });
});

describe('classifyGitFileStatus', () => {
  test('M/A/D/? codes with added-over-modified precedence', () => {
    expect(classifyGitFileStatus(file('a', 'A', ' '))).toBe('git-added');
    expect(classifyGitFileStatus(file('a', ' ', '?'))).toBe('git-added');
    expect(classifyGitFileStatus(file('a', 'D', ' '))).toBe('git-deleted');
    expect(classifyGitFileStatus(file('a', 'M', ' '))).toBe('git-modified');
    expect(classifyGitFileStatus(file('a', ' ', 'M'))).toBe('git-modified');
    expect(classifyGitFileStatus(file('a', ' ', ' '))).toBe(null);
    expect(classifyGitFileStatus(file('a', 'A', 'M'))).toBe('git-added');
  });

  test('open beats git and first duplicate wins', () => {
    const index = createFileTreeStatusIndex({
      root: ROOT,
      openPaths: [`${ROOT}/b.ts`],
      gitFiles: [
        file('a.ts', 'M', ' '),
        file('a.ts', 'A', ' '),
        file('b.ts', 'M', ' '),
      ],
    });
    expect(index.getFileStatus(`${ROOT}/b.ts`)).toBe('open');
    expect(index.getFileStatus(`${ROOT}/a.ts`)).toBe('git-modified');
    expect(index.getFileStatus(`${ROOT}/missing.ts`)).toBe(null);
  });
});

describe('folder badges', () => {
  test('modified/added predicates stay independent across every code pair', () => {
    for (const staged of [' ', 'A', 'M', 'D', '?', 'R']) {
      for (const working of [' ', 'A', 'M', 'D', '?', 'R']) {
        const modified = staged === 'M' || working === 'M' ? 1 : 0;
        const added = staged === 'A' || working === '?' ? 1 : 0;
        const expected = modified + added > 0 ? { modified, added } : null;
        const index = createFileTreeStatusIndex({
          root: ROOT,
          openPaths: [],
          gitFiles: [file('src/nested/a.ts', staged, working)],
        });
        expect(index.getFolderBadge(`${ROOT}/src/nested`)).toEqual(expected);
        expect(index.getFolderBadge(`${ROOT}/src`)).toEqual(expected);
        expect(index.getFolderBadge('')).toEqual(expected);
      }
    }
  });

  test('counts segment-boundary ancestors, ignores sibling prefixes and deleted-only', () => {
    const index = createFileTreeStatusIndex({
      root: ROOT,
      openPaths: [],
      gitFiles: [
        file('src/a.ts', 'M', ' '),
        file('src/nested/b.ts', 'A', ' '),
        file('src2/c.ts', 'M', ' '),
        file('src/gone.ts', 'D', ' '),
      ],
    });
    expect(index.getFolderBadge(`${ROOT}/src`)).toEqual({ modified: 1, added: 1 });
    expect(index.getFolderBadge(`${ROOT}/src/nested`)).toEqual({ modified: 0, added: 1 });
    expect(index.getFolderBadge(`${ROOT}/src2`)).toEqual({ modified: 1, added: 0 });
    expect(index.getFolderBadge(`${ROOT}/nothing`)).toBe(null);
  });

  test('outside-workspace, root-self, and null snapshots answer null', () => {
    const index = createFileTreeStatusIndex({
      root: ROOT,
      openPaths: [],
      gitFiles: [file('src/a.ts', 'M', ' ')],
    });
    expect(index.getFolderBadge('/elsewhere/dir')).toBe(null);
    expect(index.getFolderBadge(ROOT)).toBe(null);

    const empty = createFileTreeStatusIndex({ root: ROOT, openPaths: [], gitFiles: null });
    expect(empty.getFileStatus(`${ROOT}/a.ts`)).toBe(null);
    expect(empty.getFolderBadge(`${ROOT}/src`)).toBe(null);
  });
});

describe('scale', () => {
  test('expansion set preserves membership', () => {
    const set = createExpansionSet([`${ROOT}/a`, `${ROOT}/b`]);
    expect(set.has(`${ROOT}/a`)).toBe(true);
    expect(set.has(`${ROOT}/missing`)).toBe(false);
  });

  test('row and folder getters never revisit source paths after the build', () => {
    let pathReads = 0;
    const gitFiles = Array.from(
      { length: 2000 },
      (_, i): GitStatusFile => ({
        get path() {
          pathReads += 1;
          return `dir${i % 100}/file${i}.ts`;
        },
        index: 'M',
        working_dir: ' ',
      }),
    );
    const index = createFileTreeStatusIndex({ root: ROOT, openPaths: [], gitFiles });
    expect(pathReads).toBeGreaterThan(0);
    expect(pathReads).toBeLessThan(gitFiles.length * 4 + 1);

    const afterBuild = pathReads;
    for (let i = 0; i < 10_000; i++) {
      index.getFileStatus(`${ROOT}/dir${i % 100}/file${i}.ts`);
      index.getFolderBadge(`${ROOT}/dir${i % 100}`);
    }
    expect(pathReads).toBe(afterBuild);
  });
});
