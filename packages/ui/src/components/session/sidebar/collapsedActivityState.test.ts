import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';
import { getSessionNodesActivityState, mergeCollapsedActivityStates } from './collapsedActivityState';
import type { SessionNode } from './types';

const node = (id: string, parentID?: string, children: SessionNode[] = []): SessionNode => ({
  session: { id, parentID } as Session,
  children,
  worktree: null,
});

describe('getSessionNodesActivityState', () => {
  test('prioritizes active descendants over unread descendants', () => {
    const nodes = [node('unread'), node('root', undefined, [node('active-child', 'root')])];

    expect(getSessionNodesActivityState(
      nodes,
      new Set(['active-child']),
      new Set(['unread']),
    )).toBe('active');
  });

  test('prioritizes input descendants over active and unread descendants', () => {
    const nodes = [
      node('unread'),
      node('active'),
      node('root', undefined, [node('input-child', 'root')]),
    ];

    expect(getSessionNodesActivityState(
      nodes,
      new Set(['active']),
      new Set(['unread']),
      new Set(['input-child']),
    )).toBe('input');
  });

  test('reports input for a top-level session needing input', () => {
    expect(getSessionNodesActivityState(
      [node('waiting')],
      new Set(),
      new Set(),
      new Set(['waiting']),
    )).toBe('input');
  });

  test('reports input for a child needing input under a busy parent', () => {
    const nodes = [node('busy-parent', undefined, [node('waiting-child', 'busy-parent')])];

    expect(getSessionNodesActivityState(
      nodes,
      new Set(['busy-parent']),
      new Set(),
      new Set(['waiting-child']),
    )).toBe('input');
  });

  test('reports input for a deep descendant needing input under a busy parent', () => {
    const nodes = [
      node('busy-parent', undefined, [
        node('idle-child', 'busy-parent', [node('waiting-grandchild', 'idle-child')]),
      ]),
    ];

    expect(getSessionNodesActivityState(
      nodes,
      new Set(['busy-parent']),
      new Set(),
      new Set(['waiting-grandchild']),
    )).toBe('input');
  });

  test('keeps active for a busy parent with no descendant needing input', () => {
    const nodes = [node('busy-parent', undefined, [node('idle-child', 'busy-parent')])];

    expect(getSessionNodesActivityState(
      nodes,
      new Set(['busy-parent']),
      new Set(['idle-child']),
    )).toBe('active');
  });

  test('reports input when the busy session itself needs input', () => {
    expect(getSessionNodesActivityState(
      [node('busy-waiting')],
      new Set(['busy-waiting']),
      new Set(),
      new Set(['busy-waiting']),
    )).toBe('input');
  });

  test('includes unread subtasks in collapsed activity', () => {
    const nodes = [node('root', undefined, [node('unread-child', 'root')])];

    expect(getSessionNodesActivityState(nodes, new Set(), new Set(['unread-child']))).toBe('unread');
  });

  test('returns null when no descendant has activity', () => {
    expect(getSessionNodesActivityState([node('idle')], new Set(), new Set())).toBeNull();
  });

  test('omitting the input set preserves the previous active/unread rank', () => {
    const nodes = [node('unread'), node('root', undefined, [node('active-child', 'root')])];

    expect(getSessionNodesActivityState(
      nodes,
      new Set(['active-child']),
      new Set(['unread']),
    )).toBe('active');
  });
});

describe('mergeCollapsedActivityStates', () => {
  test('merges input above active above unread', () => {
    expect(mergeCollapsedActivityStates('unread', 'active')).toBe('active');
    expect(mergeCollapsedActivityStates('active', 'input')).toBe('input');
    expect(mergeCollapsedActivityStates('unread', 'input')).toBe('input');
    expect(mergeCollapsedActivityStates(null, null)).toBeNull();
  });
});
