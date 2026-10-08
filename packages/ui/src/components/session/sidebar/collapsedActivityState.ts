import type { SessionNode } from './types';

export type CollapsedActivityState = 'input' | 'active' | 'unread' | null;

export const EMPTY_INPUT_SESSION_IDS: ReadonlySet<string> = new Set<string>();

export const mergeCollapsedActivityStates = (
  current: CollapsedActivityState,
  next: CollapsedActivityState,
): CollapsedActivityState => {
  if (current === 'input' || next === 'input') return 'input';
  if (current === 'active' || next === 'active') return 'active';
  if (current === 'unread' || next === 'unread') return 'unread';
  return null;
};

const getSessionNodeActivityState = (
  node: SessionNode,
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
  inputSessionIds: ReadonlySet<string> = EMPTY_INPUT_SESSION_IDS,
): CollapsedActivityState => {
  if (inputSessionIds.has(node.session.id)) {
    return 'input';
  }
  if (activeSessionIds.has(node.session.id)) {
    return 'active';
  }

  let state: CollapsedActivityState = unreadSessionIds.has(node.session.id) ? 'unread' : null;
  for (const child of node.children) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(child, activeSessionIds, unreadSessionIds, inputSessionIds),
    );
    if (state === 'input') return state;
  }

  return state;
};

export const getSessionNodesActivityState = (
  nodes: SessionNode[],
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
  inputSessionIds: ReadonlySet<string> = EMPTY_INPUT_SESSION_IDS,
): CollapsedActivityState => {
  let state: CollapsedActivityState = null;
  for (const node of nodes) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(node, activeSessionIds, unreadSessionIds, inputSessionIds),
    );
    if (state === 'input') return state;
  }
  return state;
};
