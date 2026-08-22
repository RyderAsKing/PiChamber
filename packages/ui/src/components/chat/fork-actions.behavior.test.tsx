import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ElementNode = { type: unknown; props: Record<string, unknown> };
type ForkAction = (sessionId: string, messageId: string) => Promise<void>;

let forkAction: ForkAction = async () => undefined;
let restoreAction: ForkAction = async () => undefined;
const successes: string[] = [];
const errors: string[] = [];

const renderElement = (type: unknown, props: Record<string, unknown> | null): unknown => {
  const normalized = props ?? {};
  return typeof type === 'function'
    ? (type as (componentProps: Record<string, unknown>) => unknown)(normalized)
    : { type, props: normalized };
};

const jsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx: renderElement,
  jsxs: renderElement,
  jsxDEV: renderElement,
};

const React = {
  Fragment: jsxRuntime.Fragment,
  memo: <T,>(component: T) => component,
  useCallback: <T,>(callback: T) => callback,
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(initial: T | (() => T)) => {
    const value = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [value === true ? false : value, () => undefined] as const;
  },
};

const passthrough = ({ children, ...props }: Record<string, unknown>) => ({ type: 'div', props: { ...props, children } });
const button = (props: Record<string, unknown>) => ({ type: 'button', props });

mock.module('react/jsx-runtime', () => jsxRuntime);
mock.module('react/jsx-dev-runtime', () => jsxRuntime);
mock.module('react', () => ({ default: React, ...React }));
mock.module('@/components/ui', () => ({
  toast: {
    success: (message: string) => successes.push(message),
    error: (message: string) => errors.push(message),
  },
}));
mock.module('@/components/ui/button', () => ({ Button: button }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: passthrough,
  DialogContent: passthrough,
  DialogDescription: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
}));
mock.module('@/components/ui/input', () => ({ Input: passthrough }));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: passthrough,
  TooltipContent: passthrough,
  TooltipTrigger: passthrough,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: passthrough }));
mock.module('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
mock.module('@/apps/pi-session-store', () => ({
  getPiSessionStore: () => ({
    getState: () => ({ reducer: { bySession: new Map() } }),
    subscribe: () => () => undefined,
  }),
}));
mock.module('@/sync/session-ui-store', () => {
  const state = {
    currentSessionId: 'session-1',
    forkFromMessage: (sessionId: string, messageId: string) => forkAction(sessionId, messageId),
    revertToMessage: async () => undefined,
    restoreToMessage: (sessionId: string, messageId: string) => restoreAction(sessionId, messageId),
    handleSlashRedo: async () => undefined,
  };
  const useSessionUIStore = (selector: (value: typeof state) => unknown) => selector(state);
  useSessionUIStore.getState = () => state;
  return { useSessionUIStore };
});
mock.module('@/sync/sync-context', () => ({
  useSessionMessageRecords: () => [{
    info: { id: 'user-entry', role: 'user', time: { created: 1_700_000_000_000 } },
    parts: [{ type: 'text', text: 'Prompt text' }],
  }],
}));
mock.module('@/sync/revert-navigation-store', () => ({
  useRevertNavigation: () => ({
    targetEntryId: 'reverted-entry',
    abandoned: [
      { id: 'reverted-entry', role: 'user', preview: 'Reverted prompt' },
      { id: 'later-entry', role: 'user', preview: 'Later prompt' },
    ],
  }),
}));
mock.module('./lib/messagePreview', () => ({
  getFullText: () => 'Prompt text',
  getMessagePreview: () => 'Prompt text',
}));

import { TimelineDialog } from './TimelineDialog';
import { MessageForkAction } from './message/MessageForkAction';
import { MessageRevertAction } from './message/MessageRevertAction';
import { RevertedMessageDock } from './composer/ui/RevertedMessageDock';

const walk = (value: unknown, visit: (node: ElementNode) => boolean): ElementNode | undefined => {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walk(child, visit);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const node = value as ElementNode;
  if (visit(node)) return node;
  return walk(node.props?.children, visit);
};

const textContent = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return textContent((value as ElementNode).props?.children);
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const renderComponent = (component: unknown, props: Record<string, unknown>): unknown => {
  if (typeof component === 'function') return component(props);
  const memoType = (component as { type?: unknown })?.type;
  if (typeof memoType === 'function') return memoType(props);
  throw new Error('Component is not renderable');
};

beforeEach(() => {
  forkAction = async () => undefined;
  restoreAction = async () => undefined;
  successes.length = 0;
  errors.length = 0;
});

describe('message branch action feedback', () => {
  test('newest message does not render a revert action', () => {
    const tree = renderComponent(MessageRevertAction, {
      sessionId: 'session-1',
      messageId: 'latest-message-id',
      isLatestMessage: true,
    });
    expect(tree).toBeNull();
  });

  test('message action shows success only after the fork resolves', async () => {
    let resolveFork!: () => void;
    forkAction = () => new Promise<void>((resolve) => { resolveFork = resolve; });
    const tree = renderComponent(MessageForkAction, { sessionId: 'session-1', messageId: 'live-message-id' });
    const forkButton = walk(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'Fork conversation from here');
    expect(forkButton).toBeDefined();

    const pending = (forkButton?.props.onClick as (event: { stopPropagation(): void; preventDefault(): void }) => Promise<void>)({
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
    });
    await flushPromises();
    expect(successes).toEqual([]);

    resolveFork();
    await pending;
    expect(successes).toEqual(['Forked — new session created from this message.']);
    expect(errors).toEqual([]);
  });

  test('timeline stays open and reports a rejected fork', async () => {
    forkAction = async () => { throw new Error('Fork target not found'); };
    const openChanges: boolean[] = [];
    const tree = TimelineDialog({
      open: true,
      onOpenChange: (open) => openChanges.push(open),
      onFork: (messageId) => forkAction('session-1', messageId),
    });
    const forkButton = walk(tree, (node) => node.type === 'button' && textContent(node.props.children).trim() === 'Fork');
    expect(forkButton).toBeDefined();

    (forkButton?.props.onClick as () => void)();
    await flushPromises();
    expect(openChanges).toEqual([]);
    expect(errors).toEqual(['Fork target not found']);
  });

  test('reverted-message dock reports a rejected restore', async () => {
    restoreAction = async () => { throw new Error('Restore target not found'); };
    const tree = renderComponent(RevertedMessageDock, { sessionId: 'session-1' });
    const restoreButton = walk(tree, (node) => node.type === 'button' && textContent(node.props.children).trim() === 'Restore');
    expect(restoreButton).toBeDefined();

    (restoreButton?.props.onClick as () => void)();
    await flushPromises();
    expect(errors).toEqual(['Restore target not found']);
    expect(successes).toEqual([]);
  });

  test('reverted-message dock reports a rejected fork', async () => {
    forkAction = async () => { throw new Error('Fork target not found'); };
    const tree = renderComponent(RevertedMessageDock, { sessionId: 'session-1' });
    const forkButton = walk(tree, (node) => node.type === 'button' && textContent(node.props.children).trim() === 'Fork');
    expect(forkButton).toBeDefined();

    (forkButton?.props.onClick as () => void)();
    await flushPromises();
    expect(errors).toEqual(['Fork target not found']);
    expect(successes).toEqual([]);
  });
});
