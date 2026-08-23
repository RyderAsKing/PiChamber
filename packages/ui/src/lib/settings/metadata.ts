import type { SidebarSection } from '@/constants/sidebar';
import type { IconName } from '@/components/icon/icons';

export type SettingsPageSlug =
  | 'home'
  | 'general'
  | 'projects'
  | 'remote-instances'
  | 'providers'
  | 'behavior'
  | 'skills.installed'
  | 'git'
  | 'appearance'
  | 'chat'
  | 'dictation'
  | 'shortcuts'
  | 'sessions'
  | 'magic-prompts'
  | 'snippets'
  | 'notifications'
  | 'tunnel'
  | 'about';

type SettingsPageGroup =
  | 'general'
  | 'projects'
  | 'agent';

export interface SettingsRuntimeContext {
  isWeb: boolean;
  isDesktop: boolean;
  isMobile: boolean;
}

export interface SettingsPageMeta {
  slug: SettingsPageSlug;
  title: string;
  group: SettingsPageGroup;
  kind: 'single' | 'split';
  description?: string;
  keywords?: string[];
  isAvailable?: (ctx: SettingsRuntimeContext) => boolean;
}

export const SETTINGS_PAGE_METADATA: readonly SettingsPageMeta[] = [
  {
    slug: 'home',
    title: 'Settings',
    group: 'general',
    kind: 'single',
    description: 'Search and jump to common pages.',
    keywords: ['search', 'settings'],
  },
  {
    slug: 'general',
    title: 'General',
    group: 'general',
    kind: 'single',
    keywords: ['general', 'startup', 'launch at login', 'autostart', 'tray', 'password', 'passkey', 'security', 'privacy', 'telemetry', 'transport', 'network', 'lan', 'binary', 'cli', 'diagnostics', 'performance'],
  },
  {
    slug: 'projects',
    title: 'Projects',
    group: 'projects',
    kind: 'split',
    keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'],
  },
  {
    slug: 'remote-instances',
    title: 'Remote Instances',
    group: 'projects',
    kind: 'single',
    keywords: ['ssh', 'remote', 'instances', 'tunnels', 'forwarding', 'connection'],
  },
  {
    slug: 'providers',
    title: 'Providers',
    group: 'agent',
    kind: 'single',
    keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'],
  },
  {
    slug: 'behavior',
    title: 'Behavior',
    group: 'agent',
    kind: 'single',
    keywords: ['behavior', 'agents.md', 'system prompt', 'global rules', 'instructions', 'override'],
  },
  {
    slug: 'skills.installed',
    title: 'Skills',
    group: 'agent',
    kind: 'single',
    keywords: ['skill', 'skills', 'instructions', 'install', 'catalog'],
  },
  {
    slug: 'git',
    title: 'Git',
    group: 'projects',
    kind: 'single',
    keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'],
  },
  {
    slug: 'appearance',
    title: 'Appearance',
    group: 'general',
    kind: 'single',
    keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'keyboard', 'viewport', 'mobile', 'terminal', 'pwa', 'install name', 'app shortcuts'],
  },
  {
    slug: 'chat',
    title: 'Chat',
    group: 'general',
    kind: 'single',
    keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'],
  },
  {
    slug: 'dictation',
    title: 'Dictation',
    group: 'general',
    kind: 'single',
    description: 'Record speech and insert a final transcript into the composer.',
    keywords: ['voice', 'speech', 'microphone', 'transcription', 'stt', 'whisper', 'parakeet'],
  },
  {
    slug: 'shortcuts',
    title: 'Shortcuts',
    group: 'general',
    kind: 'single',
    keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'],
  },
  {
    slug: 'sessions',
    title: 'Sessions',
    group: 'general',
    kind: 'single',
    keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'limits', 'zen'],
  },
  {
    slug: 'magic-prompts',
    title: 'PiChamber Utility Prompts',
    group: 'agent',
    kind: 'split',
    keywords: ['prompts', 'templates', 'git', 'github', 'review', 'commit', 'pull request', 'utility'],
    isAvailable: () => false,
  },
  {
    slug: 'snippets',
    title: 'Snippets',
    group: 'agent',
    kind: 'single',
    keywords: ['prompt', 'templates', 'multi-run', 'strategy', 'approach'],
  },

  { slug: 'notifications', title: 'Notifications', group: 'general', kind: 'single', keywords: ['alerts', 'native', 'summary', 'summarization'], },
  { slug: 'tunnel', title: 'External Tunnel', group: 'projects', kind: 'single', keywords: ['tunnel', 'external', 'cloudflare', 'qr', 'remote', 'mobile', 'share'], isAvailable: () => false, },
  { slug: 'about', title: 'About', group: 'general', kind: 'single', keywords: ['about', 'version', 'updates', 'release', 'changelog', 'pi', 'pichamber', 'open source'] },
] as const;

const LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG: Record<SidebarSection, SettingsPageSlug> = {
  sessions: 'sessions',
  skills: 'skills.installed',
  providers: 'providers',
  'git-identities': 'git',
  settings: 'home',
};

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const normalized = slug.trim().toLowerCase();
  return (SETTINGS_PAGE_METADATA as readonly SettingsPageMeta[]).find((page) => page.slug === normalized) ?? null;
}

export function resolveSettingsSlug(value: string | null | undefined): SettingsPageSlug {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'home';
  }

  const legacy = (LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG as Record<string, SettingsPageSlug>)[normalized];
  if (legacy) {
    return legacy;
  }

  const direct = getSettingsPageMeta(normalized);
  if (direct) {
    return direct.slug;
  }

  return 'home';
}

// Lives here (not in SettingsView) so light consumers such as the command
// palette can render settings entries without statically importing the whole
// settings surface into the eager startup graph.
export function getSettingsNavIcon(slug: SettingsPageSlug): IconName | null {
  switch (slug) {
    case 'general':
      return 'settings-3';
    case 'projects':
      return 'folders';
    case 'remote-instances':
      return 'computer';
    case 'appearance':
      return 'palette';
    case 'chat':
      return 'chat-ai-3';
    case 'dictation':
      return 'mic';
    case 'magic-prompts':
      return 'ai-generate-2';
    case 'snippets':
      return 'chat-thread';
    case 'notifications':
      return 'notification-3';
    case 'shortcuts':
      return 'command';
    case 'sessions':
      return 'chat-history';

    case 'providers':
      return 'cloud';
    case 'behavior':
      return 'brain';

    case 'skills.installed':
      return 'book-open';

    case 'git':
      return 'git-branch';

    case 'tunnel':
      return 'home-office';
    case 'about':
      return 'information';
    case 'home':
      return null;
    default:
      return 'robot-2';
  }
}
