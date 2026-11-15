import type {
  PiProjectSandboxSetting,
  PiProjectSandboxState,
  PiSandboxExtraFolder,
  PiSandboxMode,
} from '@/lib/pi/protocol';

/** Editable form of a project's sandbox setting. Lists are kept as typed
 *  text until saved, so a half-typed value is never sent. */
export interface ProjectSandboxDraft {
  mode: PiSandboxMode;
  hostsText: string;
  portsText: string;
  folders: PiSandboxExtraFolder[];
}

export const draftFromState = (state: PiProjectSandboxState | undefined): ProjectSandboxDraft => ({
  mode: state?.mode ?? 'off',
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

/** Whether saving `setting` would change what the server holds. */
export const settingDiffers = (setting: PiProjectSandboxSetting, state: PiProjectSandboxState | undefined): boolean => {
  const saved = {
    mode: state?.mode ?? 'off',
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
