import { describe, expect, test } from 'bun:test';

import { formatRunUsage, parseSubagentDetails, runFooterMeta, runsFromInput, summarizeRuns, summarizeToolCall, type SubagentRun } from './details';

const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 900, turns: 2 };

const assistant = (...content: unknown[]) => ({ role: 'assistant', content });

describe('parseSubagentDetails: PiChamber shape', () => {
  test('reads runs as sent', () => {
    const details = parseSubagentDetails({
      mode: 'parallel',
      results: [
        { agent: 'scout', agentSource: 'bundled', task: 'Find auth', status: 'running', usage, activity: [{ kind: 'tool', name: 'bash', text: '$ rg token' }], output: '' },
        { agent: 'planner', task: 'Plan', status: 'done', usage, activity: [], output: '1. Do it' },
      ],
    }, 'running');
    expect(details?.mode).toBe('parallel');
    expect(details?.runs.map((run) => run.status)).toEqual(['running', 'done']);
    expect(details?.runs[0]?.activity[0]).toEqual({ kind: 'tool', name: 'bash', text: '$ rg token' });
    expect(details?.runs[1]?.output).toBe('1. Do it');
  });

  test('a run still marked running after the call ended reads as stopped', () => {
    const details = parseSubagentDetails({ mode: 'single', results: [{ agent: 'a', task: 't', status: 'running' }] }, 'cancelled');
    expect(details?.runs[0]?.status).toBe('aborted');
  });
});

describe('parseSubagentDetails: Pi example shape', () => {
  test('single run in progress, then done', () => {
    const live = {
      mode: 'single',
      results: [{ agent: 'scout', agentSource: 'user', task: 'Look', exitCode: 0, messages: [assistant({ type: 'toolCall', name: 'read', arguments: { path: 'src/a.ts' } })], stderr: '', usage }],
    };
    expect(parseSubagentDetails(live, 'running')?.runs[0]).toMatchObject({ status: 'running', activity: [{ kind: 'tool', name: 'read', text: 'read src/a.ts' }] });
    const done = { ...live, results: [{ ...live.results[0], messages: [...live.results[0].messages, assistant({ type: 'text', text: 'Found it.' })] }] };
    expect(parseSubagentDetails(done, 'completed')?.runs[0]).toMatchObject({ status: 'done', output: 'Found it.' });
  });

  test('parallel placeholders are waiting until they produce messages', () => {
    const details = parseSubagentDetails({
      mode: 'parallel',
      results: [
        { agent: 'a', task: '1', exitCode: -1, messages: [], usage },
        { agent: 'b', task: '2', exitCode: -1, messages: [assistant({ type: 'text', text: 'hi' })], usage },
        { agent: 'c', task: '3', exitCode: 1, messages: [], stderr: 'boom', usage },
      ],
    }, 'running');
    expect(details?.runs.map((run) => run.status)).toEqual(['queued', 'running', 'failed']);
    expect(details?.runs[2]?.error).toBe('boom');
  });

  test('chain: earlier steps are done, the last one runs', () => {
    const details = parseSubagentDetails({
      mode: 'chain',
      results: [
        { agent: 'scout', task: 'a', step: 1, exitCode: 0, messages: [assistant({ type: 'text', text: 'ctx' })], usage },
        { agent: 'planner', task: 'b', step: 2, exitCode: 0, messages: [], usage },
      ],
    }, 'running');
    expect(details?.runs.map((run) => [run.step, run.status])).toEqual([[1, 'done'], [2, 'running']]);
  });

  test('aborted stop reason', () => {
    const details = parseSubagentDetails({ mode: 'single', results: [{ agent: 'a', task: 't', exitCode: 0, stopReason: 'aborted', messages: [] }] }, 'error');
    expect(details?.runs[0]?.status).toBe('aborted');
  });
});

test('other details are not sub-agent calls', () => {
  expect(parseSubagentDetails(undefined, 'completed')).toBeNull();
  expect(parseSubagentDetails({ title: 'x' }, 'completed')).toBeNull();
});

test('runsFromInput queues the requested runs', () => {
  expect(runsFromInput({ agent: 'scout', task: 'Look' })?.runs).toMatchObject([{ agent: 'scout', status: 'queued' }]);
  expect(runsFromInput({ tasks: [{ agent: 'a', task: '1' }, { agent: 'b', task: '2' }] })?.mode).toBe('parallel');
  expect(runsFromInput({ chain: [{ agent: 'a', task: '1' }] })?.runs[0]?.step).toBe(1);
  expect(runsFromInput({})).toBeNull();
});

test('summaries', () => {
  expect(summarizeToolCall('bash', { command: 'ls -la' })).toBe('$ ls -la');
  expect(summarizeToolCall('grep', { pattern: 'x', path: 'src' })).toBe('grep /x/ in src');
  expect(summarizeToolCall('custom', {})).toBe('custom');
  expect(formatRunUsage({ turns: 1, input: 9000, output: 1000, cost: 0, contextTokens: 0 })).toBe('1 turn · 10k tokens');
  const done = { agent: 'a', source: 'x', task: '', status: 'done' as const, usage: { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 }, activity: [], output: '' };
  expect(summarizeRuns([done, { ...done, status: 'failed' }, { ...done, status: 'running' }])).toBe('1 of 3 done, 1 failed');
  expect(summarizeRuns([done, { ...done, status: 'aborted' }, { ...done, status: 'failed' }])).toBe('1 of 3 done, 1 failed, 1 stopped');
});

describe('runFooterMeta', () => {
  const base: SubagentRun = {
    agent: 'scout', source: 'bundled', task: 't', status: 'running',
    usage: { input: 1200, output: 300, cost: 0, contextTokens: 0, turns: 2 },
    activity: [], output: '',
  };

  test('a working run shows its last tool, or Thinking', () => {
    expect(runFooterMeta(base)).toBe('Thinking');
    expect(runFooterMeta({ ...base, activity: [{ kind: 'tool', text: 'read billing.ts' }] })).toBe('read billing.ts');
    expect(runFooterMeta({ ...base, activity: [{ kind: 'tool', text: 'read a' }, { kind: 'text', text: 'hm' }] })).toBe('Thinking');
  });

  test('a finished run shows usage; other states show nothing', () => {
    expect(runFooterMeta({ ...base, status: 'done' })).toBe(formatRunUsage(base.usage));
    expect(runFooterMeta({ ...base, status: 'failed' })).toBe('');
  });
});
