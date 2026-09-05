/**
 * Regression guard: the terminal main view is a full-page overlay that hides
 * the session (MainLayout renders it as secondaryView when
 * activeMainTab === 'terminal', and the persisted tab restores across
 * reloads). Unlike DiagramView ("Close diagram view"), it had no exit
 * affordance on desktop (no header tabs), trapping users on the terminal
 * with no visible way back to their session.
 *
 * TerminalView must therefore offer an opt-in close-view action that its
 * main-view host (MainLayout) wires back to chat. Panel/drawer hosts must
 * not show it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const terminalViewSource = readFileSync(join(__dirname, '..', '..', 'TerminalView.tsx'), 'utf-8');
const mainLayoutSource = readFileSync(
  join(__dirname, '..', '..', '..', 'layout', 'MainLayout.tsx'),
  'utf-8',
);

describe('terminal main view exit affordance', () => {
  test('TerminalView accepts an opt-in close-view action', () => {
    expect(terminalViewSource).toContain('onCloseView');
  });

  test('the close action is rendered as an accessible icon-only button', () => {
    expect(terminalViewSource).toContain('{onCloseView ? (');
    expect(terminalViewSource).toContain('onClick={onCloseView}');
    expect(terminalViewSource).toContain("title={'Close terminal view'}");
    expect(terminalViewSource).toContain("aria-label={'Close terminal view'}");
  });

  test('MainLayout wires the terminal overlay back to chat', () => {
    expect(mainLayoutSource).toContain('<TerminalView');
    const start = mainLayoutSource.indexOf("case 'terminal':");
    expect(start).toBeGreaterThan(-1);
    const window = mainLayoutSource.slice(start, start + 500);
    expect(window).toContain('onCloseView');
  });
});
