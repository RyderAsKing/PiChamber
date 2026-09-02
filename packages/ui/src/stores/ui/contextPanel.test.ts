import { describe, expect, test } from 'bun:test';

import {
  buildContextPanelTabID,
  clampContextPanelRoots,
  clampContextPanelTabs,
  clampContextPanelWidth,
  closeContextPanelTab,
  collapseDiffTabsToGit,
  createContextPanelTab,
  normalizeContextTabLabel,
  normalizeContextTargetPath,
  normalizePendingDiffScope,
  reorderContextPanelTabs,
  resolveSharedContextPanelWidth,
  sanitizeContextPanelTabs,
  touchContextPanelState,
  upsertContextPanelTab,
  type ContextPanelDirectoryState,
} from './contextPanel';

describe('contextPanel domain logic', () => {
  describe('clampContextPanelWidth', () => {
    test('returns default when width is not finite', () => {
      expect(clampContextPanelWidth(NaN)).toBe(380);
      expect(clampContextPanelWidth(Infinity)).toBe(380);
    });

    test('clamps between min (380) and max (1400)', () => {
      expect(clampContextPanelWidth(200)).toBe(380);
      expect(clampContextPanelWidth(500)).toBe(500);
      expect(clampContextPanelWidth(2000)).toBe(1400);
    });
  });

  describe('resolveSharedContextPanelWidth', () => {
    test('returns direct width if finite number', () => {
      expect(resolveSharedContextPanelWidth({ width: 450 })).toBe(450);
    });

    test('falls back to known widthByMode keys', () => {
      expect(resolveSharedContextPanelWidth({ widthByMode: { file: 600 } })).toBe(600);
    });

    test('returns undefined when neither is valid', () => {
      expect(resolveSharedContextPanelWidth({})).toBe(undefined);
      expect(resolveSharedContextPanelWidth({ width: 'invalid' })).toBe(undefined);
    });
  });

  describe('normalizeContextTargetPath', () => {
    test('normalizes backslashes to forward slashes and trims', () => {
      expect(normalizeContextTargetPath('  src\\components\\App.tsx  ')).toBe('src/components/App.tsx');
    });

    test('returns null for empty or non-string inputs', () => {
      expect(normalizeContextTargetPath('')).toBeNull();
      expect(normalizeContextTargetPath('   ')).toBeNull();
      expect(normalizeContextTargetPath(null)).toBeNull();
      expect(normalizeContextTargetPath(undefined)).toBeNull();
    });
  });

  describe('normalizeContextTabLabel', () => {
    test('trims and enforces max label length', () => {
      expect(normalizeContextTabLabel('  short label  ')).toBe('short label');
      const longLabel = 'a'.repeat(150);
      expect(normalizeContextTabLabel(longLabel)?.length).toBe(120);
    });

    test('returns null for empty strings', () => {
      expect(normalizeContextTabLabel('')).toBeNull();
      expect(normalizeContextTabLabel(null)).toBeNull();
    });
  });

  describe('normalizePendingDiffScope', () => {
    test('accepts valid scopes', () => {
      expect(normalizePendingDiffScope('all')).toBe('all');
      expect(normalizePendingDiffScope('working')).toBe('working');
      expect(normalizePendingDiffScope('staged')).toBe('staged');
      expect(normalizePendingDiffScope('turn')).toBe('turn');
      expect(normalizePendingDiffScope('branch')).toBe('branch');
    });

    test('rejects invalid scopes', () => {
      expect(normalizePendingDiffScope('invalid')).toBeNull();
      expect(normalizePendingDiffScope(null)).toBeNull();
    });
  });

  describe('buildContextPanelTabID & createContextPanelTab', () => {
    test('builds tab ID without prefix if dedupeKey matches mode', () => {
      expect(buildContextPanelTabID('git', 'git')).toBe('git');
      expect(buildContextPanelTabID('file', 'src/a.ts')).toBe('file:src/a.ts');
    });

    test('creates context panel tab with defaults', () => {
      const tab = createContextPanelTab({ mode: 'file', targetPath: 'src/index.ts' });
      expect(tab.id).toBe('file:src/index.ts');
      expect(tab.mode).toBe('file');
      expect(tab.targetPath).toBe('src/index.ts');
      expect(tab.diffScope).toBe('working');
      expect(tab.readOnly).toBe(false);
    });
  });

  describe('upsertContextPanelTab & closeContextPanelTab', () => {
    const initialState: ContextPanelDirectoryState = {
      isOpen: false,
      expanded: false,
      tabs: [],
      activeTabId: null,
      touchedAt: 1000,
    };

    test('upserts new tab and opens panel', () => {
      const updated = upsertContextPanelTab(initialState, { mode: 'git' });
      expect(updated.isOpen).toBe(true);
      expect(updated.tabs).toHaveLength(1);
      expect(updated.activeTabId).toBe('git');
    });

    test('updates existing tab without duplicate ID', () => {
      const state1 = upsertContextPanelTab(initialState, { mode: 'file', targetPath: 'a.ts' });
      const state2 = upsertContextPanelTab(state1, { mode: 'file', targetPath: 'a.ts', readOnly: true });
      expect(state2.tabs).toHaveLength(1);
      expect(state2.tabs[0].readOnly).toBe(true);
    });

    test('closes tab and activates remaining tab of same mode if available', () => {
      let state = upsertContextPanelTab(initialState, { mode: 'file', targetPath: 'a.ts' });
      state = upsertContextPanelTab(state, { mode: 'file', targetPath: 'b.ts' });
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe('file:b.ts');

      const closed = closeContextPanelTab(state, 'file:b.ts');
      expect(closed.tabs).toHaveLength(1);
      expect(closed.activeTabId).toBe('file:a.ts');
      expect(closed.isOpen).toBe(true);
    });
  });

  describe('reorderContextPanelTabs', () => {
    test('reorders tabs accurately', () => {
      const initial: ContextPanelDirectoryState = {
        isOpen: true,
        expanded: false,
        tabs: [
          createContextPanelTab({ mode: 'git' }),
          createContextPanelTab({ mode: 'terminal' }),
          createContextPanelTab({ mode: 'context' }),
        ],
        activeTabId: 'git',
        touchedAt: 1000,
      };

      const reordered = reorderContextPanelTabs(initial, 'git', 'context');
      expect(reordered.tabs.map((t) => t.id)).toEqual(['terminal', 'context', 'git']);
    });
  });

  describe('collapseDiffTabsToGit', () => {
    test('collapses legacy diff tabs to single git tab', () => {
      const tabs = [
        createContextPanelTab({ mode: 'diff' }),
        createContextPanelTab({ mode: 'git' }),
        createContextPanelTab({ mode: 'file', targetPath: 'a.ts' }),
      ];
      const collapsed = collapseDiffTabsToGit(tabs);
      expect(collapsed).toHaveLength(2);
      expect(collapsed.map((t) => t.mode)).toEqual(['git', 'file']);
    });
  });

  describe('clampContextPanelRoots', () => {
    test('keeps only the most recently touched roots', () => {
      const roots: Record<string, ContextPanelDirectoryState> = {
        '/dir1': { ...touchContextPanelState(), touchedAt: 100 },
        '/dir2': { ...touchContextPanelState(), touchedAt: 300 },
        '/dir3': { ...touchContextPanelState(), touchedAt: 200 },
      };

      const clamped = clampContextPanelRoots(roots, 2);
      expect(Object.keys(clamped)).toEqual(['/dir2', '/dir3']);
    });
  });
});
