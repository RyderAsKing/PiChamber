import type {
  PiProjectSandboxChoice,
  PiProjectSandboxSetting,
  PiProjectSandboxState,
  PiSandboxDefaults,
  PiSandboxExtraFolder,
} from '@/lib/pi/protocol';

/** Editable form of a project's sandbox setting. Lists are kept as typed
 *  text until saved, so a half-typed value is never sent. */
export interface ProjectSandboxDraft {
  mode: PiProjectSandboxChoice;
  hostsText: string;
  portsText: string;
  folders: PiSandboxExtraFolder[];
}

/** The project's own choice; an older server sends only the mode it runs with. */
const choiceOf = (state: PiProjectSandboxState | undefined): PiProjectSandboxChoice =>
  state?.choice ?? state?.mode ?? 'default';

/** Whether a choice sandboxes the project, given the server's default. An
 *  unknown default falls back to what the project runs with now. */
export const choiceSandboxes = (
  choice: PiProjectSandboxChoice,
  defaults: PiSandboxDefaults | null,
  state: PiProjectSandboxState | undefined,
): boolean => {
  if (choice !== 'default') return choice === 'nono';
  if (defaults) return defaults.invalid === true || defaults.mode === 'nono';
  return state?.mode === 'nono';
};

export const draftFromState = (state: PiProjectSandboxState | undefined): ProjectSandboxDraft => ({
  mode: choiceOf(state),
  hostsText: (state?.allowHosts ?? []).join('\n'),
  portsText: (state?.allowLocalPorts ?? []).join(', '),
  folders: (state?.extraFolders ?? []).map((folder) => ({ ...folder })),
});

const splitList = (text: string): string[] =>
  text.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);

/** Hosts, one per line or comma separated, without duplicates. */
export const parseHosts = (text: string): string[] => [...new Set(splitList(text))];

type ParsedPorts = { ok: true; ports: number[] } | { ok: false; invalid: string };

/** Ports 1-65535, comma or space separated. Reports the first bad entry. */
export const parsePorts = (text: string): ParsedPorts => {
  const ports: number[] = [];
  for (const entry of splitList(text)) {
    const port = /^\d+$/.test(entry) ? Number(entry) : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, invalid: entry };
    if (!ports.includes(port)) ports.push(port);
  }
  return { ok: true, ports };
};

type BuiltSetting = { ok: true; setting: PiProjectSandboxSetting } | { ok: false; error: string };

/**
 * The setting to save. Folder rows with an empty path are drafts and are
 * left out; the server checks everything else (absolute paths, host
 * syntax, limits) and refuses a bad setting.
 */
export const buildSetting = (draft: ProjectSandboxDraft): BuiltSetting => {
  const ports = parsePorts(draft.portsText);
  if (!ports.ok) return { ok: false, error: `"${ports.invalid}" is not a port number from 1 to 65535.` };
  return {
    ok: true,
    setting: {
      mode: draft.mode,
      allowHosts: parseHosts(draft.hostsText),
      allowLocalPorts: ports.ports,
      extraFolders: draft.folders
        .map((folder) => ({ path: folder.path.trim(), access: folder.access }))
        .filter((folder) => folder.path.length > 0),
    },
  };
};

/**
 * What a change to the draft saves. A draft that cannot be built saves
 * nothing and reports why, except when it turns the sandbox off: Off must
 * not wait on an unfinished grant, so it is saved with the grants the
 * server already holds.
 */
export const settingToSave = (
  draft: ProjectSandboxDraft,
  state: PiProjectSandboxState | undefined,
): { setting: PiProjectSandboxSetting | null; error: string | null } => {
  const built = buildSetting(draft);
  if (built.ok) return { setting: built.setting, error: null };
  if (draft.mode !== 'off' || !state) return { setting: null, error: built.error };
  return {
    setting: {
      mode: 'off',
      allowHosts: state.allowHosts,
      allowLocalPorts: state.allowLocalPorts,
      extraFolders: state.extraFolders.map((folder) => ({ path: folder.path, access: folder.access })),
    },
    error: built.error,
  };
};

/** Whether saving `setting` would change what the server holds. */
export const settingDiffers = (setting: PiProjectSandboxSetting, state: PiProjectSandboxState | undefined): boolean => {
  const saved = {
    mode: choiceOf(state),
    allowHosts: state?.allowHosts ?? [],
    allowLocalPorts: state?.allowLocalPorts ?? [],
    extraFolders: (state?.extraFolders ?? []).map((folder) => ({ path: folder.path, access: folder.access })),
  };
  return JSON.stringify(saved) !== JSON.stringify({
    mode: setting.mode,
    allowHosts: setting.allowHosts ?? [],
    allowLocalPorts: setting.allowLocalPorts ?? [],
    extraFolders: setting.extraFolders ?? [],
  });
};

/** Hosts in one-click groups for the shared list. Each is a plain host:
 *  nono matches names exactly, and every entry widens what the agent can
 *  reach, so a group holds only what its tools fetch from. */
export const HOST_PRESETS = {
  github: [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ],
  registries: [
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'pypi.org',
    'files.pythonhosted.org',
    'crates.io',
    'index.crates.io',
    'static.crates.io',
    'proxy.golang.org',
    'sum.golang.org',
    'rubygems.org',
    'index.rubygems.org',
    'repo.maven.apache.org',
    'jsr.io',
    'npm.jsr.io',
  ],
} as const;

/** `hosts` with every host of `preset` added after them, no duplicates. */
export const withPreset = (hosts: readonly string[], preset: readonly string[]): string[] =>
  [...new Set([...hosts, ...preset])];

/** Whether every host of `preset` is in `hosts` already. */
export const hasPreset = (hosts: readonly string[], preset: readonly string[]): boolean =>
  preset.every((host) => hosts.includes(host));
