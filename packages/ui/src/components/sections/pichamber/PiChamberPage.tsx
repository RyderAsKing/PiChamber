import React from 'react';
import { PiChamberVisualSettings } from './PiChamberVisualSettings';
import { AboutSettings } from './AboutSettings';
import { SessionRetentionSettings } from './SessionRetentionSettings';
import { PasskeySettings } from './PasskeySettings';
import { DefaultsSettings } from './DefaultsSettings';
import { GitSettings } from './GitSettings';
import { NotificationSettings } from './NotificationSettings';
import { GitHubSettings } from './GitHubSettings';
import { TunnelSettings } from './TunnelSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { PiChamberSection } from './types';

const useRuntimeEndpointEpoch = (): number => {
    const [epoch, setEpoch] = React.useState(0);

    React.useEffect(() => {
        return subscribeRuntimeEndpointChanged(() => setEpoch((current) => current + 1));
    }, []);

    return epoch;
};

interface PiChamberPageProps {
    /** Which section to display. If undefined, shows all sections (mobile/legacy behavior) */
    section?: PiChamberSection;
}

export const PiChamberPage: React.FC<PiChamberPageProps> = ({ section }) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    const showAbout = isMobile && isWebRuntime();
    void runtimeEndpointEpoch;
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();

    // If no section specified, show all (mobile/legacy behavior)
    if (!section) {
        return (
            <SettingsPageLayout showSaveStatus className="openchamber-page-body space-y-3 sm:space-y-6">
                <PiChamberVisualSettings />
                <DefaultsSettings />
                {showDesktopNetworkSettings && <DesktopNetworkSettings />}
                <SessionRetentionSettings />
                {isWebRuntime() && !isDesktopShell() && !isCapacitorApp() && <PasskeySettings />}
                {showAbout && <AboutSettings />}
            </SettingsPageLayout>
        );
    }

    // Show specific section content
    const renderSectionContent = () => {
        switch (section) {
            case 'general':
                return <GeneralSectionContent />;
            case 'visual':
                return <VisualSectionContent />;
            case 'chat':
                return <ChatSectionContent />;
            case 'sessions':
                return <SessionsSectionContent />;
            case 'shortcuts':
                return <ShortcutsSectionContent />;
            case 'git':
                return <GitSectionContent />;
            case 'github':
                return <GitHubSectionContent />;
            case 'notifications':
                return <NotificationSectionContent />;
            case 'tunnel':
                return <TunnelSectionContent />;
            default:
                return null;
        }
    };

    const pageTitle = {
        general: t('settings.page.general.title'),
        visual: t('settings.page.appearance.title'),
        chat: t('settings.page.chat.title'),
        sessions: t('settings.page.sessions.title'),
        shortcuts: t('settings.page.shortcuts.title'),
        git: t('settings.page.git.title'),
        github: t('settings.page.git.title'),
        notifications: t('settings.page.notifications.title'),
        tunnel: t('settings.page.tunnel.title'),
    }[section];

    const pageDescription = {
        general: t('settings.page.general.description'),
        visual: t('settings.page.appearance.description'),
        chat: t('settings.page.chat.description'),
        sessions: t('settings.page.sessions.description'),
        shortcuts: t('settings.page.shortcuts.description'),
        git: undefined,
        github: undefined,
        notifications: t('settings.page.notifications.description'),
        tunnel: t('settings.page.tunnel.description'),
    }[section];

    return (
        <SettingsPageLayout
            title={pageTitle}
            description={pageDescription}
            showSaveStatus
            className="openchamber-page-body"
        >
            {renderSectionContent()}
        </SettingsPageLayout>
    );
};

const ShortcutsSectionContent: React.FC = () => {
    return <KeyboardShortcutsSettings />;
};

// General section: app-level settings — startup/tray/network, access password,
// passkeys, OpenCode CLI binary, message stream transport, privacy.
const GeneralSectionContent: React.FC = () => {
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    void runtimeEndpointEpoch;
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();
    // Passkeys only work against the browser's WebAuthn UI on the web surface —
    // desktop shell and the Capacitor app never show the login screen.
    const showPasskeySettings = isWebRuntime() && !isDesktopShell() && !isCapacitorApp();
    return (
        <>
            {showDesktopNetworkSettings && <DesktopNetworkSettings />}
            {showPasskeySettings && <PasskeySettings />}
            <PiChamberVisualSettings visibleSettings={[
                'fileEditorKeymap',
                'autoSaveEnabled',
                'expandedEditorToolbar',
                'terminalQuickKeys',
                'terminalShell',
                'terminalLoginShell',
                'messageTransport',
                'reportUsage',
            ]} />
        </>
    );
};

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
const VisualSectionContent: React.FC = () => {
    return <PiChamberVisualSettings visibleSettings={[
        'theme',
        'windowControlsPosition',
        'pwaInstallName',
        'pwaOrientation',
        'mobileKeyboardMode',
        'timeFormat',
        'weekStart',
        'fontSize',
        'terminalFontSize',
        'editorFontSize',
        'spacing',
        'inputBarOffset',
    ]} />;
};

// Chat section: User message rendering, Diff layout, Mobile status bar, Show reasoning traces, Follow-up behavior, Persist draft
const ChatSectionContent: React.FC = () => {
    return (
        <PiChamberVisualSettings
            visibleSettings={[
                'chatRenderMode',
                'activityRenderMode',
                'userMessageRendering',
                'mermaidRendering',
                'reasoning',
                'showToolFileIcons',
                'showTurnChangedFiles',
                'expandedTools',
                'collapsibleUserMessages',
                'stickyUserHeader',
                'promptNavigatorEnabled',
                'wideChatLayout',
                'codeBlockLineWrap',
                'splitAssistantMessageActions',
                'subagentReadOnlyBanner',
                'diffLayout',
                'dotfiles',
                'fileViewerPreview',
                'followUpBehavior',
                'persistDraft',
                'inputSpellcheck',
            ]}
        />
    );
};

// Sessions section: Default model, Session retention
const SessionsSectionContent: React.FC = () => {
    return (
        <>
            <DefaultsSettings />
            <SessionRetentionSettings />
        </>
    );
};

// Git section: Commit message model
const GitSectionContent: React.FC = () => {
    return <GitSettings />;
};

// GitHub section: Connect account for PR/issue workflows
const GitHubSectionContent: React.FC = () => {
    return <GitHubSettings />;
};

// Notifications section: Native browser notifications
const NotificationSectionContent: React.FC = () => {
    return <NotificationSettings />;
};

const TunnelSectionContent: React.FC = () => {
    return <TunnelSettings />;
};
