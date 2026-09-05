/**
 * Regression guard: panel-hosted diff surfaces rendered a second header row
 * (the inline diff toolbar with the change-scope picker such as "Last turn"
 * plus view actions) underneath the ContextPanel header. The toolbar now
 * portals into a panel header slot (terminal/git pattern) so the panel keeps
 * a single header row; hosts without panel chrome keep the inline row.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(__dirname, '..', '..');
const diffViewSource = readFileSync(join(viewsDir, 'DiffView.tsx'), 'utf-8');
const gitViewSource = readFileSync(join(viewsDir, 'GitView.tsx'), 'utf-8');
const contextPanelSource = readFileSync(
  join(viewsDir, '..', 'layout', 'ContextPanel.tsx'),
  'utf-8',
);

describe('diff toolbar slot', () => {
  test('DiffView portals its toolbar into a host-provided slot', () => {
    expect(diffViewSource).toContain('toolbarSlot');
    expect(diffViewSource).toContain('createPortal');
  });

  test('DiffView keeps the inline toolbar for hosts without panel chrome', () => {
    expect(diffViewSource).toContain('diff-toolbar');
    expect(diffViewSource).toContain('hideToolbar ? null : toolbarRow');
  });

  test('the toolbar keeps the scope picker and every view action', () => {
    expect(diffViewSource).toContain('<ChangeScopeSelector');
    expect(diffViewSource).toContain('handleExpandOrCollapseAll');
    expect(diffViewSource).toContain('setLoadFullFiles');
    expect(diffViewSource).toContain('setDiffWrapLines');
    expect(diffViewSource).toContain('handleHeaderLayoutChange');
  });

  test('ContextPanel hosts the diff toolbar in its header row', () => {
    expect(contextPanelSource).toContain('diffHeaderSlot');
    expect(contextPanelSource).toContain('setDiffHeaderSlot');
    expect(contextPanelSource).toContain('toolbarSlot={');
  });

  test('the non-repo git tab reuses the git slot for its last-turn toolbar', () => {
    expect(gitViewSource).toContain('diffScope="turn"');
    expect(gitViewSource).toContain('toolbarSlot={gitHeaderSlot}');
  });

  test('mobile hosts without panel chrome keep the inline toolbar', () => {
    const mobileSource = readFileSync(join(viewsDir, 'git', 'MobileGitChrome.tsx'), 'utf-8');
    expect(mobileSource).not.toContain('toolbarSlot');
  });
});
