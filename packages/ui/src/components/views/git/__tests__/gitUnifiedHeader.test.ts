/**
 * Regression guard: the git panel collapsed three stacked header rows (the
 * ContextPanel "Git" label row plus GitHeader's branch/identity row and its
 * sync/views row, with the diff toolbar as a fourth) into one meaningful
 * header row. GitView owns a single GitUnifiedHeader and portals it into the
 * panel header slot (terminal pattern); hosts without panel chrome render the
 * same row locally. The embedded DiffView hides its inline toolbar and
 * reports its scope counts plus view actions to that header, so no feature
 * is lost. Non-repo surfaces keep the inline diff toolbar (last turn scope).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gitDir = join(__dirname, '..');
const viewsDir = join(__dirname, '..', '..');
const gitViewSource = readFileSync(join(viewsDir, 'GitView.tsx'), 'utf-8');
const diffViewSource = readFileSync(join(viewsDir, 'DiffView.tsx'), 'utf-8');
const headerSource = readFileSync(join(gitDir, 'GitUnifiedHeader.tsx'), 'utf-8');
const contextPanelSource = readFileSync(
  join(viewsDir, '..', 'layout', 'ContextPanel.tsx'),
  'utf-8',
);

describe('git unified header', () => {
  test('the two-row GitHeader is gone', () => {
    expect(existsSync(join(gitDir, 'GitHeader.tsx'))).toBe(false);
    expect(gitViewSource).not.toContain('GitHeader');
  });

  test('GitView portals a single header row into a host-provided slot', () => {
    expect(gitViewSource).toContain('gitHeaderSlot');
    expect(gitViewSource).toContain('createPortal');
    expect(gitViewSource).toContain('<GitUnifiedHeader');
  });

  test('GitView keeps a single local header row for hosts without panel chrome', () => {
    expect(gitViewSource).toContain('border-b border-border');
  });

  test('the unified header keeps every control visible or one menu away', () => {
    expect(headerSource).toContain('<BranchSelector');
    expect(headerSource).toContain('<IdentityDropdown');
    expect(headerSource).toContain('<ChangeScopeSelector');
    expect(headerSource).toContain('<SyncActions');
    expect(headerSource).toContain('Repository views');
    expect(headerSource).toContain('History');
    expect(headerSource).toContain('Graph');
    expect(headerSource).toContain('Stashes');
    expect(headerSource).toContain('Update branch');
    expect(headerSource).toContain('Re-integrate commits');
    expect(headerSource).toContain('Expand all');
    expect(headerSource).toContain('Load full files');
    expect(headerSource).toContain('Wrap lines');
    expect(headerSource).toContain('side-by-side');
  });

  test('header icon buttons stay accessible', () => {
    expect(headerSource).toContain('aria-label');
  });

  test('the embedded DiffView hides its toolbar and reports header state', () => {
    expect(diffViewSource).toContain('hideToolbar');
    expect(diffViewSource).toContain('onHeaderControlsStateChange');
    expect(gitViewSource).toContain('hideToolbar');
    expect(gitViewSource).toContain('onHeaderControlsStateChange');
  });

  test('non-repo surfaces keep the inline diff toolbar for last-turn scope', () => {
    expect(gitViewSource).toContain('diffScope="turn"');
  });

  test('ContextPanel hosts the git controls in its header row', () => {
    expect(contextPanelSource).toContain('gitHeaderSlot');
    expect(contextPanelSource).toContain('gitHeaderSlot={');
  });
});
