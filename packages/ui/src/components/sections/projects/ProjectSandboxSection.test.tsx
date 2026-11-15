import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiProjectSandboxState } from '@/lib/pi/protocol';
import { sandboxReasonText } from '@/lib/pi/sandboxText';
import type { ProjectEntry } from '@/lib/api/types';
import { ProjectCard } from './ProjectCard';
import { ProjectSandboxSectionView } from './ProjectSandboxSection';
import { SandboxingSectionView } from './SandboxingSection';

const state = (overrides: Partial<PiProjectSandboxState> = {}): PiProjectSandboxState => ({
  projectId: 'p1',
  mode: 'nono',
  launcher: 'nono',
  availability: { state: 'available' },
  allowHosts: ['registry.npmjs.org'],
  allowLocalPorts: [8080],
  extraFolders: [{ path: '/home/me/docs', access: 'readWrite' }],
  ...overrides,
});

const renderSection = (
  project: PiProjectSandboxState | undefined,
  extra: { loadFailed?: boolean; saveError?: string } = {},
) => renderToStaticMarkup(
  <ProjectSandboxSectionView
    projectId="p1"
    state={project}
    loadFailed={extra.loadFailed ?? false}
    saving={false}
    saveError={extra.saveError}
    onReload={() => {}}
    onSave={async () => {}}
  />,
);

const renderLaunchers = (launchers: Parameters<typeof SandboxingSectionView>[0]['launchers']) =>
  renderToStaticMarkup(<SandboxingSectionView launchers={launchers} loadFailed={false} rechecking={false} onRecheck={() => {}} />);

const projectEntry: ProjectEntry = { id: 'p1', path: '/home/me/app' } as ProjectEntry;


describe('ProjectSandboxSection', () => {
  test('a sandboxed project shows its hosts, ports, folders and the trust warning', () => {
    const html = renderSection(state());
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('registry.npmjs.org');
    expect(html).toContain('value="8080"');
    expect(html).toContain('/home/me/docs');
    expect(html).toContain('resets this project&#x27;s trust');
    expect(html).not.toContain('will not run');
  });

  test('an unsandboxed project shows only the mode', () => {
    const html = renderSection(state({ mode: 'off', availability: { state: 'off' } }));
    expect(html).not.toContain('Allowed hosts');
    expect(html).not.toContain('resets this project');
  });

  test('an unavailable sandbox says sessions will not run, with the reason', () => {
    const html = renderSection(state({ availability: { state: 'unavailable', reason: 'NO_LANDLOCK' } }));
    expect(html).toContain('Sessions in this project will not run until the sandbox is available.');
    expect(html).toContain(sandboxReasonText('NO_LANDLOCK').replace(/'/g, '&#x27;'));
  });

  test('a refused save shows its error', () => {
    const html = renderSection(state(), { saveError: 'The server refused this setting. Check the hosts, ports and folders.' });
    expect(html).toContain('The server refused this setting.');
  });

  test('a failed load offers to try again instead of showing Off', () => {
    const html = renderSection(undefined, { loadFailed: true });
    expect(html).toContain('could not be loaded');
    expect(html).not.toContain('aria-pressed');
  });
});

describe('SandboxingSection', () => {
  test('shows an available launcher with its version', () => {
    const html = renderLaunchers([{ id: 'nono', available: true, version: '0.82.0' }]);
    expect(html).toContain('Available, version 0.82.0');
    expect(html).toContain('Check again');
  });

  test('shows why a launcher is unavailable', () => {
    const html = renderLaunchers([{ id: 'nono', available: false, reason: 'NOT_INSTALLED' }]);
    expect(html).toContain('nono is not installed on the server machine.');
  });
});

describe('ProjectCard sandbox label', () => {
  test('labels sandboxed and unavailable projects, and nothing for off', () => {
    const sandboxed = renderToStaticMarkup(<ProjectCard project={projectEntry} sandbox={state()} onSelect={() => {}} />);
    expect(sandboxed).toContain('>Sandboxed<');
    const unavailable = renderToStaticMarkup(
      <ProjectCard project={projectEntry} sandbox={state({ availability: { state: 'unavailable', reason: 'NO_LANDLOCK' } })} onSelect={() => {}} />,
    );
    expect(unavailable).toContain('Sandbox unavailable');
    const off = renderToStaticMarkup(
      <ProjectCard project={projectEntry} sandbox={state({ mode: 'off', availability: { state: 'off' } })} onSelect={() => {}} />,
    );
    expect(off).not.toContain('Sandbox');
  });
});
