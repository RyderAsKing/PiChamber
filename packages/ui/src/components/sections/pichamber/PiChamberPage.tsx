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
        general: "General",
        visual: "Appearance",
        chat: "Chat",
        sessions: "Sessions",
        shortcuts: "Shortcuts",
        git: "Git",
        github: "Git",
        notifications: "Notifications",
        tunnel: "External Tunnel",
    }[section];

    const pageDescription = {
        general: "App startup, security, connection, and privacy.",
        visual: "Customize how PiChamber looks and feels.",
        chat: "Configure how messages and tools are displayed.",
        sessions: "Set defaults and retention for sessions.",
        shortcuts: "Customize keyboard shortcuts.",
        git: undefined,
        github: undefined,
        notifications: "Choose when and how you get notified.",
        tunnel: "Expose this instance over a remote tunnel.",
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
