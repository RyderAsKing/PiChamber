import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { BashExecutionRow } = await import('./BashExecutionRow');

type Props = Parameters<typeof BashExecutionRow>[0];

const render = (state: Props['state'], sessionId: string | undefined = 'sess-1') =>
  renderToStaticMarkup(<BashExecutionRow messageId="row-1" sessionId={sessionId} state={state} />);

describe('BashExecutionRow', () => {
  test('a running command shows its status, output, and a Stop action', () => {
    const markup = render({
      kind: 'live',
      execution: { id: 'bash-1', command: 'npm test', phase: 'running', startedAt: 1, output: 'PASS 3 tests' },
    });
    expect(markup).toContain('npm test');
    expect(markup).toContain('>Running<');
    expect(markup).toContain('PASS 3 tests');
    expect(markup).toContain('aria-label="Stop the shell command"');
  });

  test('output renders as plain text, not markup', () => {
    const markup = render({ kind: 'recorded', details: { command: 'cat x', output: '<b>bold</b>' } });
    expect(markup).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(markup).not.toContain('<b>bold</b>');
  });

  test('recorded commands show non-zero exits, cancellation, and the excluded label', () => {
    expect(render({ kind: 'recorded', details: { command: 'false', output: '', exitCode: 1 } })).toContain('Exit code 1');
    expect(render({ kind: 'recorded', details: { command: 'sleep 9', output: '', cancelled: true } })).toContain('>Cancelled<');
    const excluded = render({ kind: 'recorded', details: { command: 'ls', output: 'a', exitCode: 0, excludeFromContext: true } });
    expect(excluded).toContain('Not sent to the model');
    expect(excluded).not.toContain('Exit code');
    expect(excluded).not.toContain('Stop the shell command');
  });

  test('truncated output says so without exposing the server path outside local desktop', () => {
    const markup = render({
      kind: 'recorded',
      details: { command: 'yes', output: 'y', truncated: true, fullOutputPath: '/tmp/pi-bash-123.log' },
    });
    expect(markup).toContain('Output truncated');
    expect(markup).toContain('Earlier output was discarded. Only the last 50 KB is kept.');
    expect(markup).not.toContain('/tmp/pi-bash-123.log');
  });

  test('a finished command waiting for the turn to end and a failed command explain themselves', () => {
    expect(render({
      kind: 'live',
      execution: { id: 'bash-1', command: 'ls', phase: 'completed', startedAt: 1, exitCode: 0 },
    })).toContain('Added to the conversation when the current response ends.');
    const failed = render({
      kind: 'live',
      execution: { id: 'bash-2', command: 'ls', phase: 'failed', startedAt: 1, error: 'An extension failed while handling this command.' },
    });
    expect(failed).toContain('>Failed<');
    expect(failed).toContain('An extension failed while handling this command.');
  });
});
