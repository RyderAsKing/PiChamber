export type PiResourceSettingsPage =
  | 'providers'
  | 'skills.installed'
  | 'snippets'
  | 'behavior'
  | 'magic-prompts';

export const parsePiResourceSettingsPage = (value: string | null | undefined): PiResourceSettingsPage | null => {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'skills' || normalized === 'skills.installed') return 'skills.installed';
  if (normalized === 'providers' || normalized === 'snippets' || normalized === 'behavior' || normalized === 'magic-prompts') {
    return normalized;
  }
  return null;
};
