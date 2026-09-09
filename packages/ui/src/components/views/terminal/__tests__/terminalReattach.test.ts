/**
 * Terminal #11: same-runtime transport switches must reattach existing PTYs
 * without restarting them, preserving tab identity, scrollback, viewport dims,
 * and xterm selection. Different runtimes must never adopt old IDs.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const terminalViewSource = readFileSync(join(__dirname, '..', '..', 'TerminalView.tsx'), 'utf-8');
const tabPaneSource = readFileSync(join(__dirname, '..', 'TerminalTabPane.tsx'), 'utf-8');
const hookSource = readFileSync(join(__dirname, '..', 'useTerminalSessionStream.ts'), 'utf-8');
const apiSource = readFileSync(join(__dirname, '..', '..', '..', '..', 'lib', 'terminalApi.ts'), 'utf-8');

describe('terminal reattach preserves viewport identity', () => {
  test('panes stay mounted while hidden so VT state/selection survives tab switches', () => {
    expect(tabPaneSource).toContain('Panes stay mounted while hidden');
    expect(terminalViewSource).toContain('<TerminalTabPane');
    // Hidden panes use CSS hiding, not unmounting.
    expect(tabPaneSource).toContain("'hidden'");
  });

  test('viewport identity is tab-stable, never PTY-session keyed (no remount on reattach)', () => {
    // sessionKey must be directory+tab, not the PTY sessionId, so a same-ID
    // reattach does not remount the xterm instance (dims/selection preserved).
    expect(terminalViewSource).toContain('sessionKey={`${effectiveDirectory}::${tab.id}`');
    expect(terminalViewSource).toContain('key={tab.id}');
    expect(terminalViewSource).not.toContain('key={tab.terminalSessionId');
  });

  test('transport switch reattaches via connect, creation stays for null IDs only', () => {
    // Reattach goes through startStream/connect with existing IDs; creation
    // lives only in the ensure-session path for null sessionIds (fresh PTYs).
    expect(hookSource).toContain('subscribeTerminalTransportGeneration');
    expect(hookSource).toContain('getTerminalTransportGeneration');
    expect(hookSource).toContain('startStream(directory, tab.id, tab.terminalSessionId)');
    expect(hookSource).toContain('if (!terminalId)');
  });

  test('shared auth/URL/relay routing stays centralized', () => {
    expect(apiSource).toContain('openRuntimeWebSocket');
    expect(apiSource).toContain('getRuntimeUrlResolver().websocket');
    expect(apiSource).toContain('refreshRuntimeUrlAuthToken');
    expect(apiSource).toContain('clearRuntimeUrlAuthToken');
    expect(apiSource).not.toContain('new WebSocket(');
  });

  test('renamed transport reset no longer claims input-only disposal', () => {
    expect(apiSource).toContain('resetTerminalTransport');
    expect(apiSource).not.toContain('disposeTerminalInputTransport');
  });
});
