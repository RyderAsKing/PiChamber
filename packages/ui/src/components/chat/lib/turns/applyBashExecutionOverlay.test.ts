import { describe, expect, test } from 'bun:test';

import type { PiBashExecution } from '@/lib/pi/protocol';

import { applyBashExecutionOverlay } from './applyBashExecutionOverlay';
import type { ChatMessageEntry } from './types';

const message = (id: string, created: number): ChatMessageEntry => ({
  info: { id, role: 'user', sessionID: 'sess-1', time: { created } },
  parts: [],
});

const execution = (overrides: Partial<PiBashExecution> = {}): PiBashExecution => ({
  id: 'bash-1',
  command: 'ls',
  phase: 'running',
  startedAt: 5,
  ...overrides,
});

describe('applyBashExecutionOverlay', () => {
  test('returns the input array when there is nothing to overlay', () => {
    const messages = [message('m1', 1)];
    expect(applyBashExecutionOverlay(messages, [], 'sess-1')).toBe(messages);
    expect(applyBashExecutionOverlay(messages, [execution()], null)).toBe(messages);
  });

  test('appends live executions after the transcript as reserved shell rows', () => {
    const messages = [message('m1', 1), message('m2', 10)];
    const live = execution();
    const merged = applyBashExecutionOverlay(messages, [live], 'sess-1');
    expect(merged.map((entry) => entry.info.id)).toEqual(['m1', 'm2', 'bash:bash-1']);
    expect(merged[2]!.info).toMatchObject({ role: 'extension', customType: 'pichamber.bash', bashExecution: live });
  });

  test('keeps the projected entry reference while the execution is unchanged', () => {
    const live = execution();
    const first = applyBashExecutionOverlay([], [live], 'sess-1');
    const second = applyBashExecutionOverlay([message('m1', 1)], [live], 'sess-1');
    expect(second[1]).toBe(first[0]);
    const changed = applyBashExecutionOverlay([], [{ ...live, output: 'x' }], 'sess-1');
    expect(changed[0]).not.toBe(first[0]);
  });
});
