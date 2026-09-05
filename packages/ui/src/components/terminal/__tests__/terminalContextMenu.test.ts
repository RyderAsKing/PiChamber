/**
 * Regression guard: right-click Copy/Paste over the terminal must work in the
 * Electron shell.
 *
 * xterm.js renders to canvas, so Chromium sees no DOM selection and the
 * Electron native menu (built from its context params) reports Copy/Paste as
 * disabled. The viewport therefore drives the shared context menu from the
 * xterm selection instead, and suppresses the native menu.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viewportSource = readFileSync(join(__dirname, '..', 'TerminalViewport.tsx'), 'utf-8');

describe('terminal right-click copy/paste menu', () => {
  test('uses the shared context menu, not the Electron native menu', () => {
    expect(viewportSource).toContain("@/components/ui/context-menu");
    expect(viewportSource).toContain('<ContextMenu');
    expect(viewportSource).toContain('<ContextMenuTrigger');
    expect(viewportSource).toContain('<ContextMenuContent');
    expect(viewportSource).toContain('<ContextMenuItem');
  });

  test('suppresses the native menu so Electron does not show disabled items', () => {
    const start = viewportSource.indexOf('const handleContextMenu = React.useCallback(');
    expect(start).toBeGreaterThan(-1);
    const end = viewportSource.indexOf('}, []);', start);
    expect(end).toBeGreaterThan(start);
    const handler = viewportSource.slice(start, end);
    expect(handler).toContain('event?.preventDefault()');
    expect(handler).toContain('setMenuOpen(true)');
  });

  test('gates Copy on the xterm selection, not the DOM selection', () => {
    expect(viewportSource).toContain('hasTerminalSelection(terminalRef.current?.getSelection())');
    expect(viewportSource).toContain('disabled={!menuHasSelection}');
    expect(viewportSource).toContain('copyTerminalSelection(selection)');
  });

  test('pastes clipboard text through xterm and offers Select All', () => {
    expect(viewportSource).toContain('readClipboardText()');
    expect(viewportSource).toContain('terminal.paste(text)');
    expect(viewportSource).toContain('terminal?.selectAll()');
    expect(viewportSource).toContain("{'Paste'}");
    expect(viewportSource).toContain("{'Select All'}");
  });

  test('keeps Electron out of shared UI code', () => {
    expect(viewportSource).not.toContain("from 'electron'");
    expect(viewportSource).not.toContain('__PICHAMBER_DESKTOP__');
  });
});
