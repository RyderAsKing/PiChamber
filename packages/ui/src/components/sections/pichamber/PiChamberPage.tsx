import React from 'react';
import { PiChamberVisualSettings } from './PiChamberVisualSettings';
import { AboutSettings } from './AboutSettings';
import { SessionRetentionSettings } from './SessionRetentionSettings';
import { PasskeySettings } from './PasskeySettings';
import { DefaultsSettings } from './DefaultsSettings';
import { GitSettings } from './GitSettings';
import { NotificationSettings } from './NotificationSettings';
import { TunnelSettings } from './TunnelSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { CommandTriggersSettings } from './CommandTriggersSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import type { PiChamberSection } from './types';

interface PiChamberPageProps {
    /** Which section to display. If undefined, shows all sections (mobile/legacy behavior) */
    section?: PiChamberSection;
}

export const PiChamberPage: React.FC<PiChamberPageProps> = ({ section }) => {
    
    const { isMobile } = useDeviceInfo();
    const showAbout = isMobile && isWebRuntime();
    const showDesktopNetworkSettings = isDesktopShell();

    // If no section specified, show all (mobile/legacy behavior)
    if (!section) {
        return (
            <SettingsPageLayout className="pichamber-page-body space-y-3 sm:space-y-6">
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
        general: "App startup, security, connection, privacy, and diagnostics.",
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
            // The mobile header already shows the page title.
            title={isMobile ? undefined : pageTitle}
            description={isMobile ? undefined : pageDescription}
            className="pichamber-page-body"
        >
            {renderSectionContent()}
        </SettingsPageLayout>
    );
};

const ShortcutsSectionContent: React.FC = () => {
    return (
        <>
            <KeyboardShortcutsSettings />
            <CommandTriggersSettings />
        </>
    );
};

// General section: app-level settings — startup/tray/network, access password,
// passkeys, privacy, diagnostics.
const GeneralSectionContent: React.FC = () => {
    const showDesktopNetworkSettings = isDesktopShell();
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
                'perfHud',
            ]} />
        </>
    );
};

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
const VisualSectionContent: React.FC = () => {
    return <PiChamberVisualSettings visibleSettings={[
        'theme',
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

// Chat section: Diff layout, Follow-up behavior, draft starters (Features)
const ChatSectionContent: React.FC = () => {
    return (
        <PiChamberVisualSettings
            visibleSettings={[
                'diffLayout',
                'followUpBehavior',
            ]}
        />
    );
};

// Sessions section: default/small/walkthrough models, thinking, session retention
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

// Git & GitHub section fallback
const GitHubSectionContent: React.FC = () => {
    return <GitSettings />;
};

// Notifications section: Native browser notifications
const NotificationSectionContent: React.FC = () => {
    return <NotificationSettings />;
};

const TunnelSectionContent: React.FC = () => {
    return <TunnelSettings />;
};
