import React from 'react';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';

export function useAutoFollowTurnObserver(
  containerEl: HTMLDivElement | null,
  onActiveTurnChange?: (turnId: string | null) => void,
) {
  React.useEffect(() => {
    if (!onActiveTurnChange) return;
    const container = containerEl;
    if (!container) return;

    let lastActiveTurnId: string | null = null;
    const spy = createScrollSpy({
      onActive: (turnId) => {
        if (turnId === lastActiveTurnId) return;
        lastActiveTurnId = turnId;
        onActiveTurnChange(turnId);
      },
    });
    spy.setContainer(container);

    const elementByTurnId = new Map<string, HTMLElement>();
    const registerTurnNode = (node: HTMLElement) => {
      const turnId = node.dataset.turnId;
      if (!turnId) return false;
      elementByTurnId.set(turnId, node);
      spy.register(node, turnId);
      return true;
    };
    const unregisterTurnNode = (node: HTMLElement) => {
      const turnId = node.dataset.turnId;
      if (!turnId) return false;
      if (elementByTurnId.get(turnId) !== node) return false;
      elementByTurnId.delete(turnId);
      spy.unregister(turnId);
      return true;
    };
    const collectTurnNodes = (node: Node): HTMLElement[] => {
      if (!(node instanceof HTMLElement)) return [];
      const collected: HTMLElement[] = [];
      if (node.matches('[data-turn-id]')) collected.push(node);
      node.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((el) => collected.push(el));
      return collected;
    };

    container.querySelectorAll<HTMLElement>('[data-turn-id]').forEach(registerTurnNode);
    spy.markDirty();

    const mutationObserver = new MutationObserver((records) => {
      let changed = false;
      records.forEach((record) => {
        record.removedNodes.forEach((node) => {
          collectTurnNodes(node).forEach((turnNode) => {
            if (unregisterTurnNode(turnNode)) changed = true;
          });
        });
        record.addedNodes.forEach((node) => {
          collectTurnNodes(node).forEach((turnNode) => {
            if (registerTurnNode(turnNode)) changed = true;
          });
        });
      });
      if (changed) spy.markDirty();
    });
    mutationObserver.observe(container, { subtree: true, childList: true });

    const onScroll = () => spy.onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', onScroll);
      mutationObserver.disconnect();
      spy.destroy();
    };
  }, [containerEl, onActiveTurnChange]);
}
