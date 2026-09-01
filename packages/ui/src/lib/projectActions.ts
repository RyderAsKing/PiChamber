import type { IconName } from "@/components/icon/icons";

export type ProjectActionIconKey =
  | 'play'
  | 'build'
  | 'lint'
  | 'terminal'
  | 'tools'
  | 'bug'
  | 'flask'
  | 'rocket'
  | 'code'
  | 'server'
  | 'branch'
  | 'search'
  | 'settings'
  | 'brain'
  | 'stack'
  | 'robot'
  | 'command'
  | 'file';

export const PROJECT_ACTION_ICONS: Array<{
  key: ProjectActionIconKey;
  label: string;
  Icon: IconName;
}> = [
  { key: 'play', label: 'Play', Icon: 'play' },
  { key: 'build', label: 'Build', Icon: 'hammer' },
  { key: 'lint', label: 'Lint', Icon: 'checkbox-circle' },
  { key: 'terminal', label: 'Terminal', Icon: 'terminal-box' },
  { key: 'tools', label: 'Tools', Icon: 'tools' },
  { key: 'bug', label: 'Bug', Icon: 'bug' },
  { key: 'flask', label: 'Flask', Icon: 'flask' },
  { key: 'rocket', label: 'Rocket', Icon: 'rocket' },
  { key: 'code', label: 'Code', Icon: 'code' },
  { key: 'server', label: 'Server', Icon: 'server' },
  { key: 'branch', label: 'Branch', Icon: 'git-branch' },
  { key: 'search', label: 'Search', Icon: 'search' },
  { key: 'settings', label: 'Settings', Icon: 'settings-3' },
  { key: 'brain', label: 'Brain', Icon: 'brain-ai-3' },
  { key: 'stack', label: 'Stack', Icon: 'stack' },
  { key: 'robot', label: 'Robot', Icon: 'robot-2' },
  { key: 'command', label: 'Command', Icon: 'command' },
  { key: 'file', label: 'File', Icon: 'file-text' },
];

export const PROJECT_ACTION_ICON_MAP = Object.fromEntries(
  PROJECT_ACTION_ICONS.map((entry) => [entry.key, entry.Icon])
) as Record<ProjectActionIconKey, IconName>;

export const PROJECT_ACTIONS_UPDATED_EVENT = 'pichamber:project-actions-updated';

export const normalizeProjectActionDirectory = (value: string): string => {
  const trimmed = (value || '').trim().replace(/\\/g, '/');
  if (!trimmed) {
    return '';
  }
  if (trimmed === '/') {
    return '/';
  }
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
};

export const toProjectActionRunKey = (directory: string, actionId: string): string => {
  return `${normalizeProjectActionDirectory(directory)}::${actionId}`;
};
