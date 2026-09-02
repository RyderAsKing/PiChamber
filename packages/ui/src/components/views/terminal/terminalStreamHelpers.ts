import { extractTerminalPreviewUrl, isTerminalPreviewUrlAvailable } from '@/lib/terminalPreview';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { terminalControlCharacter, type TerminalModifier as Modifier, type TerminalQuickKey as MobileKey } from '@/lib/terminalInput';

export const FALLBACK_TERMINAL_SIZE = { cols: 80, rows: 24 } as const;

export const QUICK_KEY_MAP: Record<string, MobileKey> = {
  Tab: 'tab',
  Enter: 'enter',
  ArrowUp: 'arrow-up',
  ArrowDown: 'arrow-down',
  ArrowLeft: 'arrow-left',
  ArrowRight: 'arrow-right',
  Escape: 'esc',
};

export class TerminalPreviewScanner {
  private tail = '';
  private pendingUrls = new Set<string>();
  private probeGeneration = 0;

  reset() {
    this.tail = '';
    this.pendingUrls.clear();
    this.probeGeneration += 1;
  }

  scan(
    directory: string,
    tabId: string,
    data: string,
    setTabPreviewUrl: (
      dir: string,
      tab: string,
      url: string,
      opts: { locked: boolean; autoOpened: boolean }
    ) => void
  ) {
    if (!data) return;

    const combined = `${this.tail}${data}`.replace(/\r\n|\r/g, '\n');
    const lines = combined.split('\n');
    const completeText = combined.endsWith('\n')
      ? lines.join('\n')
      : lines.slice(0, -1).join('\n');
    this.tail = combined.endsWith('\n') ? '' : (lines[lines.length - 1] ?? '').slice(-1024);

    if (!completeText) return;

    const candidate = extractTerminalPreviewUrl(completeText);
    if (!candidate || this.pendingUrls.has(candidate)) return;

    const probeGen = this.probeGeneration;
    this.pendingUrls.add(candidate);

    void isTerminalPreviewUrlAvailable(candidate).then((available) => {
      this.pendingUrls.delete(candidate);
      if (!available || this.probeGeneration !== probeGen) return;

      const currentTab = useTerminalStore
        .getState()
        .getDirectoryState(directory)
        ?.tabs.find((tab) => tab.id === tabId);
      if (
        !currentTab ||
        currentTab.previewUrlLocked ||
        currentTab.previewUrl === candidate
      ) {
        return;
      }

      setTabPreviewUrl(directory, tabId, candidate, {
        locked: false,
        autoOpened: false,
      });
    });
  }
}

export const resolveTerminalControlKey = (
  event: KeyboardEvent,
  activeModifier: Modifier | null
): string | null => {
  if (activeModifier !== 'ctrl') return null;

  const rawKey = event.key;
  const code = event.code ?? '';
  const upperKey =
    rawKey.length === 1 && /[a-zA-Z]/.test(rawKey)
      ? rawKey.toUpperCase()
      : code.startsWith('Key') && code.length === 4
        ? code.slice(3).toUpperCase()
        : null;

  if (upperKey && upperKey.length === 1 && upperKey >= 'A' && upperKey <= 'Z') {
    return terminalControlCharacter(upperKey);
  }

  return null;
};
