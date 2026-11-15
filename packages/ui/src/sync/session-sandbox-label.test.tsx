import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getPiSessionStore } from '@/apps/pi-session-store';
import type { LiveSessionRecord } from './pi-session-catalog';
import { useSessionSandboxLabel } from './sync-context';

const row = (id: string, extra: Partial<LiveSessionRecord> = {}): LiveSessionRecord => ({
  id,
  directory: '/repo',
  parentId: null,
  title: id,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: false,
  ...extra,
});

const Probe: React.FC<{ id: string }> = ({ id }) => {
  const label = useSessionSandboxLabel(id);
  return <span>{label ? `${label.short}|${label.long}` : 'none'}</span>;
};

describe('useSessionSandboxLabel', () => {
  beforeEach(() => {
    const byId = getPiSessionStore().getState().catalog.byId as Map<string, LiveSessionRecord>;
    byId.clear();
    byId.set('plain', row('plain'));
    byId.set('boxed', row('boxed', { sandboxed: true }));
    byId.set('leaving', row('leaving', { sandboxed: true, pendingSwitch: { to: 'off' } }));
    byId.set('entering', row('entering', { pendingSwitch: { to: 'nono' } }));
  });

  test('reads each session row from the catalog', () => {
    expect(renderToStaticMarkup(<Probe id="plain" />)).toBe('<span>none</span>');
    expect(renderToStaticMarkup(<Probe id="boxed" />)).toBe('<span>Sandboxed|Sandboxed</span>');
    expect(renderToStaticMarkup(<Probe id="leaving" />)).toBe('<span>Switching|Leaves the sandbox after this turn</span>');
    expect(renderToStaticMarkup(<Probe id="entering" />)).toBe('<span>Switching|Moves into the sandbox after this turn</span>');
    expect(renderToStaticMarkup(<Probe id="unknown" />)).toBe('<span>none</span>');
  });
});
