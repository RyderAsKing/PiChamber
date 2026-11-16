import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiProjectSandboxState, PiSandboxDefaults } from '@/lib/pi/protocol';
import { sandboxReasonText } from '@/lib/pi/sandboxText';
import type { ProjectEntry } from '@/lib/api/types';
import { ProjectCard } from './ProjectCard';
import { ProjectSandboxSectionView } from './ProjectSandboxSection';
import { SandboxingSectionView } from './SandboxingSection';
import { sandboxLimitsAccepted, sandboxLimitsUpdate } from './sandboxLimits';

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
  extra: { loadFailed?: boolean; unavailable?: boolean; saving?: boolean; saveError?: string; defaults?: PiSandboxDefaults | null } = {},
) => renderToStaticMarkup(
  <ProjectSandboxSectionView
    projectId="p1"
    state={project}
    defaults={extra.defaults ?? null}
    loadFailed={extra.loadFailed ?? false}
    unavailable={extra.unavailable ?? false}
    saving={extra.saving ?? false}
    saveError={extra.saveError}
    onReload={() => {}}
    onSave={async () => {}}
  />,
);

const renderLaunchers = (launchers: Parameters<typeof SandboxingSectionView>[0]['launchers']) =>
  renderToStaticMarkup(<SandboxingSectionView launchers={launchers} loadFailed={false} rechecking={false} onRecheck={() => {}} />);

const projectEntry: ProjectEntry = { id: 'p1', path: '/home/me/app' } as ProjectEntry;


describe('ProjectSandboxSection', () => {
  test('a project the server has no entry for says so and offers Try again', () => {
    const html = renderSection(undefined, { unavailable: true });
    expect(html).toContain('unavailable for this project');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Loading');
  });

  test('a sandboxed project shows its hosts, ports and folders', () => {
    const html = renderSection(state({ choice: 'nono' }));
    expect(html).toContain('aria-pressed="true">On<');
    expect(html).toContain('registry.npmjs.org');
    expect(html).toContain('value="8080"');
    expect(html).toContain('/home/me/docs');
    expect(html).not.toContain('will not run');
  });

  test('an unsandboxed project shows only the choice', () => {
    const html = renderSection(state({ mode: 'off', choice: 'off', availability: { state: 'off' } }));
    expect(html).toContain('aria-pressed="true">Off<');
    expect(html).not.toContain('Allowed hosts');
  });

  test('Default names what the default is, and a project following it shows the shared hosts', () => {
    const defaults = { mode: 'nono' as const, allowHosts: ['github.com'] };
    const html = renderSection(state({ choice: 'default', allowHosts: [] }), { defaults });
    expect(html).toContain('aria-pressed="true">Default (on)<');
    expect(html).toContain('Also allowed for all projects: github.com.');
    const off = renderSection(state({ mode: 'off', choice: 'default', availability: { state: 'off' } }), { defaults: { mode: 'off', allowHosts: [] } });
    expect(off).toContain('Default (off)');
    expect(off).not.toContain('Allowed hosts');
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

  test('a save in flight keeps the text fields focusable: read-only, not disabled', () => {
    const fields = (html: string) => html.match(/<(?:input|textarea)[^>]*>/g) ?? [];
    const idle = fields(renderSection(state()));
    const saving = fields(renderSection(state(), { saving: true }));
    expect(idle.length).toBeGreaterThanOrEqual(3);
    expect(idle.some((field) => /readOnly|readonly/.test(field))).toBe(false);
    const readOnly = saving.filter((field) => /readOnly|readonly/.test(field));
    expect(readOnly.length).toBeGreaterThanOrEqual(3);
    expect(readOnly.some((field) => /\sdisabled(?:=""|\s|\/?>)/.test(field))).toBe(false);
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
    expect(html).toContain('href="https://nono.sh"');
  });

  test('offers the default for all projects and the shared hosts with presets', () => {
    const html = renderToStaticMarkup(
      <SandboxingSectionView
        launchers={[{ id: 'nono', available: true, version: '0.82.0' }]}
        loadFailed={false}
        rechecking={false}
        onRecheck={() => {}}
        defaults={{ mode: 'nono', allowHosts: ['github.com'] }}
        onSaveDefaults={async () => {}}
      />,
    );
    expect(/aria-pressed="true"[^>]*>(?:(?!<\/div>).)*Sandbox projects by default/s.test(html)).toBe(true);
    expect(html).toContain('Allowed hosts for all projects');
    expect(html).toContain('github.com');
    expect(html).toContain('Add GitHub');
    expect(html).toContain('Add package registries');
  });

  test('says when the saved default cannot be read, since projects following it stop', () => {
    const html = renderToStaticMarkup(
      <SandboxingSectionView launchers={[]} loadFailed={false} rechecking={false} onRecheck={() => {}} defaults={{ mode: 'off', allowHosts: [], invalid: true }} onSaveDefaults={async () => {}} />,
    );
    expect(html).toContain('could not be read');
  });

  test('shows why a launcher is unavailable', () => {
    const html = renderLaunchers([{ id: 'nono', available: false, reason: 'NOT_INSTALLED' }]);
    expect(html).toContain('nono is not installed on the server machine.');
  });

  test('a host with limits explains them and asks the owner to accept them', () => {
    const wsl = { id: 'nono', available: true, version: '0.82.0', limits: ['UNIX_SOCKETS'], limitsAccepted: false };
    const render = (defaults: PiSandboxDefaults) => renderToStaticMarkup(
      <SandboxingSectionView launchers={[wsl]} loadFailed={false} rechecking={false} onRecheck={() => {}} defaults={defaults} onSaveDefaults={async () => {}} />,
    );
    const pending = render({ mode: 'off', allowHosts: [], acceptedLimits: [] });
    expect(pending).toContain('Unix sockets');
    expect(pending).toContain('Use sandboxing with this limit');
    expect(pending).toContain('until you accept it.');
    const accepted = render({ mode: 'off', allowHosts: [], acceptedLimits: ['UNIX_SOCKETS'] });
    expect(accepted).toContain('Use sandboxing with this limit');
    expect(accepted).not.toContain('until you accept it.');
    expect(renderLaunchers([{ id: 'nono', available: true, version: '0.82.0' }])).not.toContain('Use sandboxing with');
    const both = renderToStaticMarkup(
      <SandboxingSectionView
        launchers={[{ ...wsl, limits: ['UNIX_SOCKETS', 'PROXY_PORT'] }]}
        loadFailed={false}
        rechecking={false}
        onRecheck={() => {}}
        defaults={{ mode: 'off', allowHosts: [], acceptedLimits: ['UNIX_SOCKETS'] }}
        onSaveDefaults={async () => {}}
      />,
    );
    expect(both).toContain('proxy&#x27;s port');
    expect(both).toContain('Use sandboxing with these limits');
    expect(both).toContain('until you accept them.');
  });

  test('acceptance follows the saved default, else the launcher flag', () => {
    const launcher = { id: 'nono', available: true, limits: ['UNIX_SOCKETS'], limitsAccepted: true };
    expect(sandboxLimitsAccepted(launcher, { mode: 'off', allowHosts: [], acceptedLimits: [] })).toBe(false);
    expect(sandboxLimitsAccepted(launcher, { mode: 'off', allowHosts: [], acceptedLimits: ['UNIX_SOCKETS'] })).toBe(true);
    expect(sandboxLimitsAccepted(launcher, null)).toBe(true);
    expect(sandboxLimitsAccepted({ ...launcher, limitsAccepted: false }, null)).toBe(false);
  });

  test('accepting or withdrawing sends only the limits, never a mode', () => {
    expect(sandboxLimitsUpdate(['UNIX_SOCKETS'], true)).toEqual({ acceptedLimits: ['UNIX_SOCKETS'] });
    expect(sandboxLimitsUpdate(['UNIX_SOCKETS'], false)).toEqual({ acceptedLimits: [] });
  });

  test('an unreadable default cannot have its limits accepted until a mode is chosen', () => {
    const render = (defaults: PiSandboxDefaults) => renderToStaticMarkup(
      <SandboxingSectionView
        launchers={[{ id: 'nono', available: true, version: '0.82.0', limits: ['UNIX_SOCKETS'] }]}
        loadFailed={false}
        rechecking={false}
        onRecheck={() => {}}
        defaults={defaults}
        onSaveDefaults={async () => {}}
      />,
    );
    const limitsBox = (html: string) => html.slice(html.indexOf('Use sandboxing with this limit') - 600, html.indexOf('Use sandboxing with this limit'));
    expect(/\sdisabled(?:=""|\s|\/?>)/.test(limitsBox(render({ mode: 'off', allowHosts: [], invalid: true })))).toBe(true);
    expect(/\sdisabled(?:=""|\s|\/?>)/.test(limitsBox(render({ mode: 'off', allowHosts: [] })))).toBe(false);
  });
});

describe('ProjectCard sandbox label', () => {
  test('labels sandboxed and unavailable projects, and nothing for off', () => {
    const sandboxed = renderToStaticMarkup(<ProjectCard project={projectEntry} sandbox={state()} onSelect={() => {}} />);
    expect(sandboxed).toContain('title="Sandboxed"');
    expect(sandboxed).toContain('#oc-lock');
    expect(sandboxed).toContain('aria-label="App project, /home/me/app, sandboxed"');
    const unavailable = renderToStaticMarkup(
      <ProjectCard project={projectEntry} sandbox={state({ availability: { state: 'unavailable', reason: 'NO_LANDLOCK' } })} onSelect={() => {}} />,
    );
    expect(unavailable).toContain('title="Sandbox unavailable"');
    expect(unavailable).toContain('>Unavailable<');
    const off = renderToStaticMarkup(
      <ProjectCard project={projectEntry} sandbox={state({ mode: 'off', availability: { state: 'off' } })} onSelect={() => {}} />,
    );
    expect(off).not.toContain('Sandbox');
  });
});
