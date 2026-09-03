/**
 * PiChamber project-level configuration service.
 * Stores per-project settings in the PiChamber data root's projects directory
 * (default `~/.config/pichamber/projects/<projectId>.json`, overridable via
 * `PICHAMBER_DATA_DIR`). Migrates from legacy
 * `<project>/.pichamber/pichamber.json`.
 */

import type { FilesAPI } from './api/types';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getDesktopHomeDirectory } from './desktop';
import { sanitizeStarterRefs, type DraftStarterRef } from './draftStarters';
import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

type ProjectRef = { id: string; path: string };

const CONFIG_FILENAME = 'pichamber.json';
// LEGACY_PROJECT_CONFIG: legacy per-project config root inside repo.
const LEGACY_CONFIG_DIR = '.pichamber';
const USER_PROJECTS_DIR_SEGMENTS = ['.config', 'pichamber', 'projects'];

/**
 * Get the runtime Files API if available (Desktop).
 */
function getRuntimeFilesAPI(): FilesAPI | null {
  const apis = getRegisteredRuntimeAPIs();
  if (apis?.files) {
    return apis.files;
  }
  return null;
}

interface PiChamberConfig {
  projectPath?: string;
  'setup-worktree'?: string[];
  'setup-worktree-wait'?: boolean;
  projectActions?: PiChamberProjectAction[];
  projectActionsPrimaryId?: string;
  draftStarters?: DraftStarterRef[];
}

type PiChamberProjectActionPlatform = 'macos' | 'linux' | 'windows';

export interface PiChamberProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string | null;
  platforms?: PiChamberProjectActionPlatform[];
  autoOpenUrl?: boolean;
  openUrl?: string;
  desktopOpenSshForward?: string;
}

export interface PiChamberProjectActionsState {
  actions: PiChamberProjectAction[];
  primaryActionId: string | null;
}

const PICHAMBER_PROJECT_ACTION_NAME_MAX_LENGTH = 80;
const PICHAMBER_PROJECT_ACTION_COMMAND_MAX_LENGTH = 4000;
const PICHAMBER_PROJECT_ACTION_OPEN_URL_MAX_LENGTH = 2000;
const PICHAMBER_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;

const PICHAMBER_ACTION_PLATFORM_SET = new Set<PiChamberProjectActionPlatform>(['macos', 'linux', 'windows']);

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalize(base);
  const cleanSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedBase || normalizedBase === '/') {
    return `/${cleanSegment}`;
  }
  return `${normalizedBase}/${cleanSegment}`;
};

const getLegacyConfigPath = (projectDirectory: string): string => {
  return joinPath(joinPath(projectDirectory, LEGACY_CONFIG_DIR), CONFIG_FILENAME);
};

const getBaseUrl = (): string => {
  const defaultBaseUrl = import.meta.env.VITE_PICHAMBER_URL || '/api';
  if (defaultBaseUrl.startsWith('/')) {
    return defaultBaseUrl;
  }
  return defaultBaseUrl;
};

const postJson = async <T>(url: string, body: unknown): Promise<{ ok: boolean; data: T | null }> => {
  try {
    const response = await runtimeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, data: null };
    }
    const data = (await response.json().catch(() => null)) as T | null;
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
};

const mkdirp = async (path: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.createDirectory) {
    try {
      const result = await runtimeFiles.createDirectory(path);
      if (result?.success) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/mkdir`, { path });
  return Boolean(res.ok);
};

const readTextFile = async (path: string, directory?: string): Promise<string | null> => {
  try {
    const response = await runtimeFetch(`${getBaseUrl()}/fs/read`, {
      // Configuration probes are optional; a missing file is an authoritative
      // absence, not an exceptional 404 that should pollute browser diagnostics.
      // Project-local legacy probes must carry their explicit workspace scope;
      // the server process cwd is not a user-selected project authority.
      query: { path, optional: 'true', ...(directory ? { directory } : {}) },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
};

const writeTextFile = async (path: string, content: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.writeFile) {
    try {
      const result = await runtimeFiles.writeFile(path, content);
      if (result?.success) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/write`, { path, content });
  return Boolean(res.ok);
};

type ResolvedServerHome = {
  home: string | null;
  pichamberDataDir: string | null;
};

let cachedResolvedHome: ResolvedServerHome | null = null;

const resolveServerHome = async (): Promise<ResolvedServerHome> => {
  if (cachedResolvedHome) {
    return cachedResolvedHome;
  }
  let home: string | null = null;
  let pichamberDataDir: string | null = null;
  // Use server-reported home as the source of truth for user config paths.
  // In some runtimes, window.__PICHAMBER_HOME__ can be workspace/project-root
  // scoped, which would incorrectly route writes into the project directory.
  try {
    const response = await runtimeFetch(`${getBaseUrl()}/fs/home`, {
      // Avoid conditional requests (304 + empty body).
      cache: 'no-store',
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null) as { home?: unknown; pichamberDataDir?: unknown } | null;
      if (typeof payload?.home === 'string') {
        home = normalize(payload.home);
      }
      if (typeof payload?.pichamberDataDir === 'string') {
        pichamberDataDir = normalize(payload.pichamberDataDir);
      }
    }
  } catch {
    // fall through to desktop fallback below
  }

  // Fallback for environments where /api/fs/home is unavailable.
  if (!home) {
    try {
      const desktopHome = await getDesktopHomeDirectory();
      if (desktopHome && desktopHome.trim().length > 0) {
        home = normalize(desktopHome);
      }
    } catch {
      // ignore
    }
  }

  cachedResolvedHome = { home, pichamberDataDir };
  return cachedResolvedHome;
};

const resolveHomeDirectory = async (): Promise<string | null> => {
  const resolved = await resolveServerHome();
  return resolved.home;
};

const resolvePiChamberDataDirectory = async (): Promise<string | null> => {
  const resolved = await resolveServerHome();
  return resolved.pichamberDataDir;
};

const getUserProjectsDirectory = async (): Promise<string | null> => {
  const pichamberDataDir = await resolvePiChamberDataDirectory();
  if (pichamberDataDir) {
    return joinPath(pichamberDataDir, 'projects');
  }
  // Narrow compatibility fallback for a PiChamber runtime too old to return
  // pichamberDataDir: honor PICHAMBER_DATA_DIR fallback relative to home.
  // Not an PiChamber-data fallback.
  const home = await resolveHomeDirectory();
  if (!home) {
    return null;
  }
  return USER_PROJECTS_DIR_SEGMENTS.reduce((acc, segment) => joinPath(acc, segment), home);
};

const resolveConfigProjectId = (project: ProjectRef): string | null => {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  const normalizedProject = projectDirectory ? normalize(projectDirectory) : '';
  if (!normalizedProject) return null;
  return createProjectIdFromPath(normalizedProject) || null;
};

const getUserConfigPath = async (project: ProjectRef): Promise<string | null> => {
  const base = await getUserProjectsDirectory();
  if (!base) {
    return null;
  }
  const safeId = resolveConfigProjectId(project);
  if (!safeId) {
    return null;
  }
  return joinPath(base, `${safeId}.json`);
};

const trimToMaxLength = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
};

const sanitizeProjectActionPlatforms = (value: unknown): PiChamberProjectActionPlatform[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique: PiChamberProjectActionPlatform[] = [];
  const seen = new Set<PiChamberProjectActionPlatform>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim().toLowerCase() as PiChamberProjectActionPlatform;
    if (!PICHAMBER_ACTION_PLATFORM_SET.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
};

const sanitizeProjectActions = (value: unknown): PiChamberProjectAction[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitized: PiChamberProjectAction[] = [];
  const seenIds = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as {
      id?: unknown;
      name?: unknown;
      command?: unknown;
      icon?: unknown;
      platforms?: unknown;
      autoOpenUrl?: unknown;
      openUrl?: unknown;
      desktopOpenSshForward?: unknown;
    };

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = trimToMaxLength(typeof record.name === 'string' ? record.name.trim() : '', PICHAMBER_PROJECT_ACTION_NAME_MAX_LENGTH);
    const command = trimToMaxLength(typeof record.command === 'string' ? record.command.trim() : '', PICHAMBER_PROJECT_ACTION_COMMAND_MAX_LENGTH);

    if (!id || !name || !command || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const iconRaw = typeof record.icon === 'string' ? record.icon.trim() : '';
    const platforms = sanitizeProjectActionPlatforms(record.platforms);
    const autoOpenUrl = record.autoOpenUrl === true;
    const openUrlRaw = typeof record.openUrl === 'string' ? record.openUrl.trim() : '';
    const openUrl = trimToMaxLength(openUrlRaw, PICHAMBER_PROJECT_ACTION_OPEN_URL_MAX_LENGTH);
    const desktopOpenSshForwardRaw = typeof record.desktopOpenSshForward === 'string'
      ? record.desktopOpenSshForward.trim()
      : '';
    const desktopOpenSshForward = trimToMaxLength(
      desktopOpenSshForwardRaw,
      PICHAMBER_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH
    );

    sanitized.push({
      id,
      name,
      command,
      icon: iconRaw || null,
      ...(autoOpenUrl ? { autoOpenUrl: true } : {}),
      ...(openUrl ? { openUrl } : {}),
      ...(desktopOpenSshForward ? { desktopOpenSshForward } : {}),
      ...(platforms.length > 0 ? { platforms } : {}),
    });
  }

  return sanitized;
};

const sanitizeProjectActionsState = (value: {
  actions?: unknown;
  primaryActionId?: unknown;
} | null | undefined): PiChamberProjectActionsState => {
  const actions = sanitizeProjectActions(value?.actions);
  const primaryRaw = typeof value?.primaryActionId === 'string' ? value.primaryActionId.trim() : '';
  const primaryActionId = primaryRaw && actions.some((entry) => entry.id === primaryRaw)
    ? primaryRaw
    : null;

  return {
    actions,
    primaryActionId,
  };
};

/**
 * Read the config for a project.
 * Returns null if file doesn't exist or is invalid.
 */
async function readPiChamberConfig(project: ProjectRef): Promise<PiChamberConfig | null> {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectDirectory) {
    return null;
  }

  const configPath = await getUserConfigPath(project);

  const readText = async (path: string, directory?: string): Promise<string | null> => {
    // Keep behavior consistent with other helpers.
    const text = await readTextFile(path, directory);
    if (text === null) {
      return null;
    }
    return text;
  };

  const parseConfig = (text: string | null): PiChamberConfig | null => {
    if (typeof text !== 'string') {
      return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed as PiChamberConfig;
    } catch {
      return null;
    }
  };

  // 1) Prefer new per-user config.
  if (configPath) {
    const existing = parseConfig(await readText(configPath));
    if (existing) {
      return existing;
    }
  }

  // 2) Migrate legacy <project>/.pichamber/pichamber.json.
  // LEGACY_PROJECT_CONFIG: migrate project-local pichamber.json -> ~/.config/pichamber/projects/<projectId>.json
  const legacyPath = getLegacyConfigPath(projectDirectory);
  const legacyConfig = parseConfig(await readText(legacyPath, projectDirectory));
  if (!legacyConfig) {
    return null;
  }

  // Best-effort write + delete legacy.
  try {
    const wrote = await writePiChamberConfig(project, legacyConfig);
    if (wrote) {
      await deleteLegacyPiChamberConfig(projectDirectory);
    }
  } catch {
    // Ignore migration failures; still return legacy content.
  }

  return legacyConfig;
}

/**
 * Write the per-user config for a project.
 *
 * Server owns the config version; client preserves it when writing shared
 * project metadata.
 */
async function writePiChamberConfig(
  project: ProjectRef,
  config: PiChamberConfig
): Promise<boolean> {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectDirectory) {
    return false;
  }

  const configDir = await getUserProjectsDirectory();
  const configPath = await getUserConfigPath(project);
  if (!configDir || !configPath) {
    return false;
  }

  try {
    const okDir = await mkdirp(configDir);
    if (!okDir) {
      return false;
    }

    const existingRaw = await readTextFile(configPath);
    let existing: Record<string, unknown> = {};
    if (typeof existingRaw === 'string' && existingRaw.trim()) {
      try {
        const parsed = JSON.parse(existingRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = {};
      }
    }

    const serverOwned: Record<string, unknown> = {};
    if (existing.version !== undefined) serverOwned.version = existing.version;

    const content = JSON.stringify({
      ...existing,
      ...config,
      ...serverOwned,
      projectPath: normalize(projectDirectory),
    }, null, 2);
    return await writeTextFile(configPath, content);
  } catch (error) {
    console.error('Failed to write pichamber config:', error);
    return false;
  }
}

/**
 * Update specific keys in the config, preserving other values.
 */
async function updatePiChamberConfig(
  project: ProjectRef,
  updates: Partial<PiChamberConfig>
): Promise<boolean> {
  const existing = await readPiChamberConfig(project) || {};
  const merged = { ...existing, ...updates };
  return writePiChamberConfig(project, merged);
}

/**
 * Get this project's pinned draft welcome starters.
 */
export async function getProjectDraftStarters(project: ProjectRef): Promise<DraftStarterRef[]> {
  const config = await readPiChamberConfig(project);
  return sanitizeStarterRefs(config?.draftStarters);
}

export async function saveProjectDraftStarters(project: ProjectRef, starters: DraftStarterRef[]): Promise<boolean> {
  return updatePiChamberConfig(project, { draftStarters: sanitizeStarterRefs(starters) });
}

export async function getProjectActionsState(project: ProjectRef): Promise<PiChamberProjectActionsState> {
  const config = await readPiChamberConfig(project);
  return sanitizeProjectActionsState({
    actions: config?.projectActions,
    primaryActionId: config?.projectActionsPrimaryId,
  });
}

export async function saveProjectActionsState(
  project: ProjectRef,
  value: PiChamberProjectActionsState
): Promise<boolean> {
  const sanitized = sanitizeProjectActionsState({
    actions: value.actions,
    primaryActionId: value.primaryActionId,
  });

  return updatePiChamberConfig(project, {
    projectActions: sanitized.actions,
    projectActionsPrimaryId: sanitized.primaryActionId ?? undefined,
  });
}

async function deleteLegacyPiChamberConfig(projectDirectory: string): Promise<void> {
  const legacyPath = getLegacyConfigPath(projectDirectory);
  const runtimeFiles = getRuntimeFilesAPI();

  if (runtimeFiles?.delete) {
    try {
      await runtimeFiles.delete(legacyPath);
      return;
    } catch {
      // fall through
    }
  }

  try {
    await postJson(`${getBaseUrl()}/fs/delete`, { path: legacyPath });
  } catch {
    // ignored
  }
}

export type { ProjectRef };
