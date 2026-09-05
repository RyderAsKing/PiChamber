/**
 * Regression guard: terminal tabs switched from a per-tab strip to a header
 * dropdown. TerminalView rendered a second header row (SortableTabsStrip of
 * terminal tabs + new/restart buttons) underneath the ContextPanel header,
 * which already has a maximize button. The switcher is now a dropdown that
 * the panel header hosts left of maximize (via slot portal); TerminalView
 * keeps a single dropdown row only for hosts without panel chrome.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(__dirname, '..', '..');
const terminalViewSource = readFileSync(join(viewsDir, 'TerminalView.tsx'), 'utf-8');
const dropdownSource = readFileSync(join(__dirname, '..', 'TerminalTabDropdown.tsx'), 'utf-8');
const contextPanelSource = readFileSync(
  join(viewsDir, '..', 'layout', 'ContextPanel.tsx'),
  'utf-8',
);

describe('terminal tabs dropdown', () => {
  test('TerminalView no longer renders a tab strip for terminals', () => {
    expect(terminalViewSource).not.toContain('SortableTabsStrip');
  });

  test('TerminalView drives the dropdown from the same tab items and actions', () => {
    expect(terminalViewSource).toContain('<TerminalTabDropdown');
    expect(terminalViewSource).toContain('handleSelectTab');
    expect(terminalViewSource).toContain('handleCloseTab');
    expect(terminalViewSource).toContain('handleCreateTab');
    expect(terminalViewSource).toContain('handleRestart');
  });

  test('TerminalView portals its header controls into a host-provided slot', () => {
    expect(terminalViewSource).toContain('terminalHeaderSlot');
    expect(terminalViewSource).toContain('createPortal');
  });

  test('the dropdown trigger follows the shared value-picker chrome', () => {
    expect(dropdownSource).toContain('dropdownTriggerVariants');
    expect(dropdownSource).toContain('arrow-down-s');
    expect(dropdownSource).toContain('aria-label');
  });

  test('the dropdown selects, closes, and creates tabs', () => {
    expect(dropdownSource).toContain('onSelect');
    expect(dropdownSource).toContain('closeLabel');
    expect(dropdownSource).toContain('New tab');
  });

  test('ContextPanel hosts the terminal controls left of maximize', () => {
    expect(contextPanelSource).toContain('terminalHeaderSlot');
    expect(contextPanelSource).toContain('terminalHeaderSlot={');
  });
});
