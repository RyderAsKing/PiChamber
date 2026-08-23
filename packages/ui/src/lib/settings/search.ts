/* eslint-disable */
// @ts-nocheck
import type { SettingsPageSlug, SettingsRuntimeContext } from './metadata';
import { getSettingsPageMeta } from './metadata';

interface SettingsSearchItem {
  id: string;
  page: SettingsPageSlug;
  title: string;
  description?: string;
  keywords?: string[];
  isAvailable?: (ctx: SettingsSearchAvailabilityContext) => boolean;
}

export interface SettingsSearchResult extends SettingsSearchItem {
  title: string;
  description: string | null;
  pageTitle: string;
}

interface SettingsSearchAvailabilityContext extends SettingsRuntimeContext {
  isMobile: boolean;
  isDesktopLocalOrigin: boolean;
  // macOS desktop shell — for controls that only render on darwin (e.g. dock badge).
  isMac: boolean;
  // Windows desktop shell — for controls that only render on win32.
  isWindows: boolean;
  // Linux desktop shell — for controls that only render on linux.
  isLinux: boolean;
  // Windows ARM64 — temporary workaround gate (see opencode#19130).
  isWindowsArm64: boolean;
}

const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'appearance.time-format',
    page: 'appearance',
    title: "Time Format",
    keywords: ['clock', '12h', '24h'],
  },
  {
    id: 'appearance.week-start',
    page: 'appearance',
    title: "Week Starts On",
    keywords: ['calendar', 'monday', 'sunday'],
  },
  {
    id: 'appearance.light-theme',
    page: 'appearance',
    title: "Light Theme",
    keywords: ['theme', 'color', 'light mode'],
  },
  {
    id: 'appearance.dark-theme',
    page: 'appearance',
    title: "Dark Theme",
    keywords: ['theme', 'color', 'dark mode'],
  },
  {
    id: 'appearance.dock-badge',
    page: 'appearance',
    title: "Dock badge",
    description: "Show a count of chats with unseen activity on the macOS dock icon.",
    keywords: ['dock', 'badge', 'unread', 'unseen', 'counter', 'count', 'notification', 'macos'],
    // Exactly matches the render guard in PiChamberVisualSettings: any darwin
    // Electron shell (isMac already implies isDesktopShell), local or remote host.
    isAvailable: (ctx) => ctx.isMac,
  },
  {
    id: 'appearance.pwa-install-name',
    page: 'appearance',
    title: "Install App Name",
    description: "Used by PWA installation process.",
    keywords: ['pwa', 'installed app'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop,
  },
  {
    id: 'appearance.pwa-orientation',
    page: 'appearance',
    title: "Install Orientation",
    description: "Used by the installed web app. Reinstall the PWA after changing this.",
    keywords: ['pwa', 'portrait', 'landscape'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop,
  },
  {
    id: 'appearance.mobile-keyboard-mode',
    page: 'appearance',
    title: "Mobile Keyboard Behavior",
    description: "Default browser behavior is safest. Resize content asks supported browsers to shrink the app when the on-screen keyboard opens.",
    keywords: ['mobile', 'keyboard', 'resize'],
    isAvailable: (ctx) => ctx.isMobile && ctx.isWeb && !ctx.isDesktop,
  },
  {
    id: 'appearance.interface-font-size',
    page: 'appearance',
    title: "Interface Font Size",
    keywords: ['font', 'text size', 'ui scale'],
  },
  {
    id: 'appearance.terminal-font-size',
    page: 'appearance',
    title: "Terminal Font Size",
    keywords: ['terminal', 'font', 'text size'],
  },
  {
    id: 'appearance.terminal-shell',
    page: 'general',
    title: "Terminal Shell",
    description: "Restart the terminal to apply this change to the current session.",
    keywords: ['terminal', 'shell', 'bash', 'zsh', 'fish', 'pwsh', 'powershell'],
  },
  {
    id: 'appearance.editor-font-size',
    page: 'appearance',
    title: "Editor Font Size",
    keywords: ['editor', 'font', 'text size', 'code'],
  },
  {
    id: 'appearance.spacing-density',
    page: 'appearance',
    title: "Spacing Density",
    keywords: ['density', 'compact', 'comfortable', 'spacing'],
  },
  {
    id: 'appearance.input-bar-offset',
    page: 'appearance',
    title: "Input Bar Offset",
    description: "Raise input bar to avoid OS-level screen obstructions like home bars.",
    keywords: ['input', 'home bar', 'offset'],
    // Only the mobile composer applies this offset (ChatInput gates on isMobile).
    isAvailable: (ctx) => ctx.isMobile,
  },
  {
    id: 'appearance.auto-save-enabled',
    page: 'general',
    title: "Auto-save files",
    description: "Automatically save file edits after you stop typing. Disable to require manual save.",
    keywords: ['editor', 'autosave', 'auto-save', 'files', 'save'],
  },
  {
    id: 'appearance.expanded-editor-toolbar',
    page: 'general',
    title: "Always show editor toolbar (docked under the file tabs)",
    keywords: ['editor', 'toolbar', 'tabs', 'docked', 'files'],
  },
  {
    id: 'appearance.file-editor-keymap',
    page: 'general',
    title: "File editor keymap",
    keywords: ['editor', 'vim', 'keymap'],
  },
  {
    id: 'appearance.terminal-quick-keys',
    page: 'general',
    title: "Terminal Quick Keys",
    description: "Show Esc, Ctrl, Arrows in terminal view",
    keywords: ['terminal', 'keyboard', 'esc', 'ctrl', 'arrows'],
  },
  {
    id: 'general.performance-overlay',
    page: 'general',
    title: "Performance overlay",
    description: "Show a live frame-time overlay for debugging jank. Adds overhead and stays on this device only.",
    keywords: ['fps', 'performance', 'hud', 'diagnostics', 'debug', 'jank', 'frame'],
  },
  {
    id: 'chat.reasoning-traces',
    page: 'chat',
    title: "Show Reasoning Traces",
    keywords: ['thinking', 'reasoning'],
  },
  {
    id: 'chat.collapsible-reasoning',
    page: 'chat',
    title: "Enable Collapsible Reasoning Blocks",
    keywords: ['thinking', 'reasoning', 'collapse', 'expand'],
  },
  {
    id: 'chat.collapsed-reasoning-default',
    page: 'chat',
    title: "Collapsed by Default",
    description: "Open thinking while it streams, then fold it. Turn off to keep a one-line trace unless you expand it.",
    keywords: ['thinking', 'reasoning', 'collapse', 'default'],
  },
  {
    id: 'chat.reasoning',
    page: 'chat',
    title: "Reasoning",
    keywords: ['thinking', 'traces'],
  },
  {
    id: 'chat.sticky-user-header',
    page: 'chat',
    title: "Sticky User Header",
    keywords: ['messages', 'header'],
  },
  {
    id: 'chat.prompt-navigator',
    page: 'chat',
    title: "Prompt Navigator",
    keywords: ['prompt', 'navigator', 'navigation', 'timeline', 'scroll'],
  },
  {
    id: 'chat.collapsible-user-messages',
    page: 'chat',
    title: "Collapse Long User Messages",
    keywords: ['collapse', 'expand', 'clamp', 'long messages', 'user messages'],
  },
  {
    id: 'chat.wide-layout',
    page: 'chat',
    title: "Wide Chat Layout",
    keywords: ['layout', 'wide', 'messages'],
  },
  {
    id: 'chat.message-appearance',
    page: 'chat',
    title: "Message Appearance",
    keywords: ['layout', 'messages', 'appearance'],
  },
  {
    id: 'chat.code-block-line-wrap',
    page: 'chat',
    title: "Wrap Code Block Lines",
    keywords: ['code', 'wrap', 'line wrap', 'markdown'],
  },
  {
    id: 'chat.inline-assistant-actions',
    page: 'chat',
    title: "Inline Assistant Actions",
    description: "Show Copy Answer, Save as image, and Read aloud on assistant text blocks that appear before later tool calls in the same response.",
    keywords: ['copy', 'save image', 'read aloud'],
  },
  {
    id: 'chat.draft-starters-visible',
    page: 'chat',
    title: "Show Starters on New Session Screen",
    keywords: ['starter', 'starters', 'new session', 'welcome', 'suggestions'],
  },
  {
    id: 'chat.subagent-read-only-banner',
    page: 'chat',
    title: "Allow Prompting Subagent Sessions",
    keywords: ['subagent', 'read only', 'prompt', 'banner'],
  },
  {
    id: 'chat.tool-file-icons',
    page: 'chat',
    title: "Show Tool File Icons",
    keywords: ['tools', 'files', 'icons'],
  },
  {
    id: 'chat.tools-and-files',
    page: 'chat',
    title: "Tools & Files",
    keywords: ['tools', 'files', 'dotfiles'],
  },
  {
    id: 'chat.changed-files',
    page: 'chat',
    title: "Show Changed Files for Completed Turns",
    keywords: ['changed files', 'turns'],
  },
  {
    id: 'chat.dotfiles',
    page: 'chat',
    title: "Show Dotfiles",
    keywords: ['hidden files'],
  },
  {
    id: 'chat.follow-up-behavior',
    page: 'chat',
    title: "Follow-up behavior",
    description: "Choose what happens when you press Enter on a follow-up message while the agent is still responding.",
    keywords: ['follow up', 'queue', 'steer', 'send immediately'],
  },
  {
    id: 'chat.persist-drafts',
    page: 'chat',
    title: "Persist Draft Messages",
    keywords: ['draft', 'message'],
  },
  {
    id: 'chat.composer',
    page: 'chat',
    title: "Composer",
    keywords: ['input', 'draft', 'spellcheck'],
  },
  {
    id: 'chat.spellcheck',
    page: 'chat',
    title: "Enable Spellcheck in Text Inputs",
    keywords: ['spelling', 'input'],
  },
  {
    id: 'sessions.default-model',
    page: 'sessions',
    title: "Default Model",
    keywords: ['model', 'provider', 'new sessions', 'picker'],
  },
  {
    id: 'sessions.default-thinking',
    page: 'sessions',
    title: "Default Thinking",
    keywords: ['thinking', 'reasoning', 'variant', 'new sessions', 'per model'],
  },
  {
    id: 'sessions.thinking-defaults',
    page: 'sessions',
    title: "Thinking defaults",
    description: "Per-model thinking for new sessions and composer model changes.",
    keywords: ['thinking', 'reasoning', 'per model', 'default thinking'],
  },
  {
    id: 'sessions.deletion-dialog',
    page: 'sessions',
    title: "Show Deletion Dialog",
    keywords: ['delete', 'confirmation'],
  },
  {
    id: 'sessions.small-model',
    page: 'sessions',
    title: "Small Model",
    description: "A cheap model for quick utility tasks like short recaps and summaries.",
    keywords: ['small model', 'utility', 'summary', 'recap', 'cheap', 'override', 'picker'],
  },
  {
    id: 'sessions.walkthrough-model',
    page: 'sessions',
    title: "Changes Walkthrough Model",
    description: "The AI review of your changes needs structured output and room for a whole diff, which a cheap small model often cannot give. Models the catalog reports as unable to produce structured output are hidden from this picker. Leave it unset and the small model is used.",
    keywords: ['walkthrough', 'diff', 'review', 'changes', 'structured output', 'model', 'override', 'picker'],
  },
  {
    id: 'sessions.auto-cleanup',
    page: 'sessions',
    title: "Enable Auto-Cleanup",
    description: "Automatically archive or delete inactive sessions based on last activity. Keeps the 5 most recent sessions.",
    keywords: ['retention', 'archive', 'delete'],
  },
  {
    id: 'sessions.retention-period',
    page: 'sessions',
    title: "Retention Period",
    keywords: ['days', 'cleanup', 'retention'],
  },
  {
    id: 'sessions.retention-action',
    page: 'sessions',
    title: "When sessions expire",
    keywords: ['archive', 'delete', 'expire'],
  },
  {
    id: 'sessions.desktop-launch-at-login',
    page: 'general',
    title: "Start PiChamber when you log in",
    description: "Starts the app in the background without opening a window. Use the desktop status icon to open it.",
    keywords: ['desktop', 'startup', 'login', 'launch', 'background', 'autostart'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-window-controls-position',
    page: 'appearance',
    title: "Window controls position",
    description: "Choose where minimize, maximize, and close buttons appear. Defaults to the right.",
    keywords: ['desktop', 'window', 'controls', 'minimize', 'maximize', 'close', 'titlebar', 'linux', 'windows'],
    isAvailable: (ctx) => ctx.isDesktop && (ctx.isWindows || !ctx.isMac),
  },
  {
    id: 'sessions.desktop-window-controls-style',
    page: 'appearance',
    title: "Style",
    keywords: ['desktop', 'window', 'controls', 'style', 'traffic', 'lights', 'classic', 'macos', 'titlebar'],
    isAvailable: (ctx) => ctx.isDesktop && (ctx.isWindows || !ctx.isMac),
  },
  {
    id: 'sessions.desktop-mac-menu-bar',
    page: 'general',
    title: "Show PiChamber in the menu bar",
    description: "Requires an app restart. When off, PiChamber does not create the menu bar item or run its session, approval, and usage updates.",
    keywords: ['desktop', 'menu bar', 'tray', 'status item', 'macos', 'background'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin && ctx.isMac,
  },
  {
    id: 'sessions.desktop-minimize-to-tray',
    page: 'general',
    title: "Minimize and close to the system tray",
    description: "Keeps PiChamber running in the system tray when the main window is minimized or closed.",
    keywords: ['desktop', 'tray', 'system tray', 'minimize', 'close', 'background', 'windows', 'linux'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin && (ctx.isWindows || ctx.isLinux),
  },
  {
    id: 'sessions.desktop-keep-awake',
    page: 'general',
    title: "Keep computer awake while PiChamber is running",
    description: "Prevents system sleep so phones can keep reaching this app. The screen can still turn off.",
    keywords: ['desktop', 'sleep', 'awake', 'server', 'mobile', 'phone'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-ui-password',
    page: 'general',
    title: "Desktop UI Password",
    description: "PiChamber asks after restart, then when the login session expires: after 12 hours, or 7 days with Trust this device. Leave empty to disable login.",
    keywords: ['desktop', 'password', 'auth', 'login'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-lan-access',
    page: 'general',
    title: "Let other devices on your local network open this app",
    description: "Restarts the app so phones, tablets, and other computers on your Wi-Fi can open it. On Windows, allow PiChamber through the firewall if a phone still cannot connect.",
    keywords: ['desktop', 'lan', 'network', 'phone', 'tablet', 'wifi', 'firewall'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.opencode-binary',
    page: 'general',
    title: 'OpenCode CLI binary path',
    keywords: ['opencode', 'cli', 'binary', 'path'],
  },
  {
    id: 'sessions.opencode-update-notifications',
    page: 'general',
    title: 'Show update notifications',
    keywords: ['opencode', 'cli', 'updates'],
    isAvailable: (ctx) => !ctx.isWindowsArm64,
  },
  {
    id: 'git.github-account',
    page: 'git',
    title: "Connect GitHub",
    keywords: ['github', 'account', 'oauth', 'prs', 'issues'],
  },
  {
    id: 'git.identities',
    page: 'git',
    title: "Identities",
    description: "Create one to manage Git author settings per project",
    keywords: ['identity', 'profile', 'author', 'email', 'credentials', 'signing', 'commit signing', 'ssh signing', 'gpg'],
  },
  {
    id: 'git.changes-view',
    page: 'git',
    title: "Changes View",
    keywords: ['changes', 'flat list', 'tree view'],
  },
  {
    id: 'git.gitmoji',
    page: 'git',
    title: "Enable Gitmoji Picker",
    keywords: ['commit', 'emoji'],
  },
  {
    id: 'git.gitignored-files',
    page: 'git',
    title: "Display Gitignored Files",
    keywords: ['ignored', 'files', 'gitignore'],
  },
  {
    id: 'projects.name',
    page: 'projects',
    title: "Name",
    keywords: ['label', 'display name', 'project metadata', 'project name'],
  },
  {
    id: 'projects.default-model',
    page: 'projects',
    title: "Default model",
    keywords: ['model', 'provider', 'new chat', 'session default', 'project metadata'],
  },
  {
    id: 'projects.worktree',
    page: 'projects',
    title: "Worktree",
    keywords: ['worktree', 'branch', 'repository'],
  },
  {
    id: 'projects.worktree.setup.wait',
    page: 'projects',
    title: "Wait for setup commands before creating or sending a session",
    keywords: ['worktree', 'setup commands', 'bootstrap', 'wait'],
  },
  {
    id: 'remote-instances.client-auth',
    page: 'remote-instances',
    title: "Connect to this server",
    description: "Create a secure link or token so PiChamber Desktop can connect to this server.",
    keywords: ['pairing link', 'client token', 'connect desktop', 'remote access', 'relay', 'devices', 'connect from anywhere'],
  },
  {
    id: 'remote-instances.direct-hosts',
    page: 'remote-instances',
    title: "Other PiChamber servers",
    description: "Servers this app can switch to. Import a pairing link from the other server, or add one by address.",
    keywords: ['server url', 'connection token', 'import link', 'host switcher', 'additional headers', 'request headers', 'cloudflare access', 'service token'],
    isAvailable: (ctx) => ctx.isDesktop,
  },
  {
    id: 'behavior.system-prompt',
    page: 'behavior',
    title: "Global AGENTS.md",
    description: "Global rules are combined with project rules",
    keywords: ['agents.md', 'global instructions', 'system prompt'],
  },
  {
    id: 'behavior.response-style',
    page: 'behavior',
    title: "Response style",
    description: "When enabled, these instructions guide how the assistant responds in each new conversation. They are sent with your first message and do not change your global AGENTS.md rules.",
    keywords: ['tone', 'concise', 'detailed', 'custom instructions'],
  },
  {
    id: 'snippets.create',
    page: 'snippets',
    title: "Create snippet",
    keywords: ['add', 'new snippet'],
  },
  {
    id: 'snippets.content',
    page: 'snippets',
    title: "Content",
    keywords: ['markdown', 'prompt', 'template'],
  },
  {
    id: 'providers.connect',
    page: 'providers',
    title: "Connect Provider",
    keywords: ['add provider', 'connect provider', 'credentials'],
  },
  {
    id: 'providers.custom',
    page: 'providers',
    title: "Custom provider",
    description: "Add an OpenAI-compatible provider with a base URL, credentials, and model list. Saved to Pi so it is available in chat like any other provider.",
    keywords: ['other', 'custom', 'openai-compatible', 'base url', 'api key'],
  },
  {
    id: 'providers.auth',
    page: 'providers',
    title: "Authentication",
    keywords: ['api key', 'oauth', 'credentials'],
  },
  {
    id: 'providers.connection-details',
    page: 'providers',
    title: "Connection Details",
    keywords: ['config', 'source', 'disconnect'],
  },
  {
    id: 'providers.models',
    page: 'providers',
    title: "Available Models",
    description: "Hide models you do not want in the composer or session default pickers.",
    keywords: ['models', 'hide', 'show'],
  },
  {
    id: 'skills.discovery',
    page: 'skills.installed',
    title: "Skills",
    keywords: ['skills', 'agent skills', 'project resources'],
  },
  {
    id: 'magic-prompts.visible-prompt',
    page: 'magic-prompts',
    title: "Visible Prompt",
    keywords: ['prompt text', 'user message', 'template'],
  },
  {
    id: 'magic-prompts.instructions',
    page: 'magic-prompts',
    title: "Instructions",
    keywords: ['hidden prompt', 'instructions', 'template'],
  },
  {
    id: 'magic-prompts.reset-overrides',
    page: 'magic-prompts',
    title: "Reset All Overrides",
    keywords: ['reset', 'default prompts', 'overrides'],
  },
  {
    id: 'shortcuts.keyboard-shortcuts',
    page: 'shortcuts',
    title: "Keyboard Shortcuts",
    description: "Capture a new key combo, save it, and bindings will update immediately.",
    keywords: ['keyboard', 'hotkeys', 'bindings'],
  },
  {
    id: 'shortcuts.command-triggers',
    page: 'shortcuts',
    title: "Command triggers",
    description: "Quick-action buttons above the composer and optional keybindings that run slash commands.",
    keywords: ['quick actions', 'slash commands', 'toolbar buttons', 'triggers'],
  },
  {
    id: 'tunnel.provider',
    page: 'tunnel',
    title: "Provider",
    description: "Configure secure remote access with quick links or your own managed remote Cloudflare tunnel.",
    keywords: ['remote access', 'cloudflare'],
  },
  {
    id: 'tunnel.type',
    page: 'tunnel',
    title: "Tunnel type",
    keywords: ['quick', 'managed remote', 'managed local'],
  },
  {
    id: 'tunnel.ttl',
    page: 'tunnel',
    title: "Connect link TTL",
    description: "Tunnel session TTL",
    keywords: ['expiry', 'expiration', 'session ttl', 'connect link ttl'],
  },
  {
    id: 'tunnel.managed-remote',
    page: 'tunnel',
    title: "Saved managed remote tunnels",
    keywords: ['cloudflare', 'hostname', 'token', 'managed remote'],
  },
  {
    id: 'tunnel.managed-local-config',
    page: 'tunnel',
    title: "Configuration file",
    description: "Managed local tunnels use your local cloudflared configuration file.",
    keywords: ['cloudflared', 'config', 'yaml', 'json', 'managed local'],
  },
  {
    id: 'tunnel.start',
    page: 'tunnel',
    title: "Start Tunnel",
    description: "Connect links are one-time and are revoked when tunnel stops or connect-link TTL expires.",
    keywords: ['connect link', 'qr code', 'public url', 'remote access'],
  },
  {
    id: 'notifications.delivery',
    page: 'notifications',
    title: "Notification Delivery",
    keywords: ['desktop notifications', 'system notifications'],
  },
  {
    id: 'notifications.events',
    page: 'notifications',
    title: "Notification Events",
    keywords: ['completion', 'subtasks', 'errors', 'questions'],
  },
  {
    id: 'notifications.push',
    page: 'notifications',
    title: "Background Push Notifications",
    keywords: ['background', 'push'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop,
  },
] as const;

interface BuildSettingsSearchResultsOptions {
  query: string;
  runtimeCtx: SettingsSearchAvailabilityContext;
  visiblePageSlugs?: SettingsPageSlug[];
  getPageTitle: (slug: SettingsPageSlug) => string;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function buildSettingsSearchResults({
  query,
  runtimeCtx,
  visiblePageSlugs,
  getPageTitle,
}: BuildSettingsSearchResultsOptions): SettingsSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const allowedPages = visiblePageSlugs ? new Set<SettingsPageSlug>(visiblePageSlugs) : null;
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  return SETTINGS_SEARCH_ITEMS.flatMap((item) => {
    if (allowedPages && !allowedPages.has(item.page)) {
      return [];
    }

    const pageMeta = getSettingsPageMeta(item.page);
    if (!pageMeta || (pageMeta.isAvailable && !pageMeta.isAvailable(runtimeCtx)) || (item.isAvailable && !item.isAvailable(runtimeCtx))) {
      return [];
    }

    const title = item.title;
    const description = item.description ?? null;
    const haystack = normalizeSearchText([
      title,
      description,
      getPageTitle(item.page),
      ...(item.keywords ?? []),
    ].filter(Boolean).join(' '));

    if (!terms.every((term) => haystack.includes(term))) {
      return [];
    }

    return [{
      ...item,
      title,
      description,
      pageTitle: getPageTitle(item.page),
    }];
  });
}
