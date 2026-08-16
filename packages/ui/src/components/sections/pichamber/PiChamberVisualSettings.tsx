import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ThemeMode } from '@/types/theme';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore, type FollowUpBehavior } from '@/stores/messageQueueStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import {
    isDesktopShell,
    isWebRuntime,
    usesFramelessElectronChrome,
    type DesktopWindowControlsPosition,
    type DesktopWindowControlsStyle,
} from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { updateDesktopSettings } from '@/lib/persistence';
import { CODE_FONT_OPTIONS, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, UI_FONT_OPTIONS, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { useConfigStore } from '@/stores/useConfigStore';
import { normalizeMobileKeyboardMode, supportsMobileKeyboardResizeContent, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { getStoredMobileLayoutPreference, setStoredMobileLayoutPreference, type MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import {
    setDirectoryShowHidden,
    useDirectoryShowHidden,
} from '@/lib/directoryShowHidden';
import {
    SettingsSection,
    SettingsTwoColumn,
    SettingsControlGroup,
    SettingsStackedField,
    SettingsFieldRow,
    SettingsInset,
    SettingsCheckboxRow,
    SettingsRadioGroup,
    SettingsRadioOption,
    SettingsChipGroup,
    SETTINGS_SELECT_TRIGGER_CLASS,
    SETTINGS_SELECT_SIZE,
    SETTINGS_ICON_BUTTON_CLASS,
    SETTINGS_CONTROL_CLUSTER_CLASS,
    SETTINGS_CLUSTER_CONTROL_CLASS,
    SETTINGS_NUMBER_STEPPER_ROW_CLASS,
    SETTINGS_NUMBER_UNIT_CLASS,
    SETTINGS_FIELDS_STACK_CLASS,
    SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { TerminalShellOption } from '@/lib/api/types';
import { isTerminalShell } from '@/lib/terminalShell';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

interface Option<T extends string> {
    id: T;
    label: string;
    description?: string;
}

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; label: string; description: string }> = [
    {
        value: 'system',
        label: "System",
        description: "Follow system setting",
    },
    {
        value: 'light',
        label: "Light",
        description: "Always use light appearance",
    },
    {
        value: 'dark',
        label: "Dark",
        description: "Always use dark appearance",
    },
];

const DIFF_LAYOUT_OPTIONS: Option<'dynamic' | 'inline' | 'side-by-side'>[] = [
    {
        id: 'dynamic',
        label: "Dynamic",
        description: "New inline, modified side-by-side.",
    },
    {
        id: 'inline',
        label: "Always inline",
        description: "Show as a single unified view.",
    },
    {
        id: 'side-by-side',
        label: "Always side-by-side",
        description: "Compare original and modified files.",
    },
];

const MERMAID_RENDERING_OPTIONS: Option<'svg' | 'ascii'>[] = [
    {
        id: 'svg',
        label: "SVG",
        description: "Render diagrams as scalable graphics.",
    },
    {
        id: 'ascii',
        label: "ASCII",
        description: "Render diagrams as text blocks.",
    },
];

const DEFAULT_PWA_INSTALL_NAME = 'PiChamber - AI Coding Assistant';
const PWA_ORIENTATION_OPTIONS: Option<'system' | 'portrait' | 'landscape'>[] = [
    {
        id: 'system',
        label: "Follow system",
        description: "Respect the device rotation setting.",
    },
    {
        id: 'portrait',
        label: "Portrait lock",
        description: "Install the app locked to portrait.",
    },
    {
        id: 'landscape',
        label: "Landscape lock",
        description: "Install the app locked to landscape.",
    },
];

const MOBILE_KEYBOARD_MODE_OPTIONS: Option<MobileKeyboardMode>[] = [
    {
        id: 'native',
        label: "Follow browser",
        description: "Use the browser default for panning and viewport changes when the keyboard opens.",
    },
    {
        id: 'resize-content',
        label: "Resize content",
        description: "Ask supported browsers to shrink the app layout instead of relying only on panning.",
    },
];

const MOBILE_LAYOUT_OPTIONS: Array<{ value: MobileLayoutPreference; label: string }> = [
    {
        value: 'default',
        label: "Old",
    },
    {
        value: 'new',
        label: "New",
    },
];

type PwaInstallNameWindow = Window & {
    __PICHAMBER_SET_PWA_INSTALL_NAME__?: (value: string) => string;
    __PICHAMBER_SET_PWA_ORIENTATION__?: (value: 'system' | 'portrait' | 'landscape') => 'system' | 'portrait' | 'landscape';
    __PICHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

const normalizePwaOrientation = (value: unknown): 'system' | 'portrait' | 'landscape' => {
    return value === 'portrait' || value === 'landscape' ? value : 'system';
};

const USER_MESSAGE_RENDERING_OPTIONS: Option<'markdown' | 'plain'>[] = [
    {
        id: 'markdown',
        label: "Markdown",
        description: "Render user text with markdown formatting.",
    },
    {
        id: 'plain',
        label: "Plain text",
        description: "Render user text with preserved whitespace and links.",
    },
];

const CHAT_RENDER_MODE_OPTIONS: Option<'sorted' | 'live'>[] = [
    {
        id: 'sorted',
        label: "Sorted",
        description: "Render completed assistant messages without live streaming.",
    },
    {
        id: 'live',
        label: "Live",
        description: "Stream assistant text and tools as they arrive.",
    },
];

const MESSAGE_STREAM_TRANSPORT_OPTIONS: Option<'auto' | 'ws' | 'sse'>[] = [
    {
        id: 'auto',
        label: "Auto",
        description: "Prefer WebSocket and fall back to SSE if needed.",
    },
    {
        id: 'ws',
        label: "WebSocket",
        description: "Use WebSocket for message streaming.",
    },
    {
        id: 'sse',
        label: "SSE",
        description: "Use Server-Sent Events for message streaming.",
    },
];

const ACTIVITY_RENDER_MODE_OPTIONS: Option<'collapsed' | 'summary'>[] = [
    {
        id: 'collapsed',
        label: "Collapsed",
        description: "Keep Activity collapsed by default.",
    },
    {
        id: 'summary',
        label: "Expanded",
        description: "Expand Activity by default.",
    },
];

const TIME_FORMAT_OPTIONS: Option<'auto' | '12h' | '24h'>[] = [
    {
        id: 'auto',
        label: "Auto",
        description: "Use system locale preference.",
    },
    {
        id: '24h',
        label: "24-hour",
        description: "Show time as 14:15.",
    },
    {
        id: '12h',
        label: "12-hour",
        description: "Show time as 02:15 PM.",
    },
];

const WEEK_START_OPTIONS: Option<'auto' | 'monday' | 'sunday'>[] = [
    {
        id: 'auto',
        label: "Auto",
        description: "Use locale week start.",
    },
    {
        id: 'monday',
        label: "Monday",
    },
    {
        id: 'sunday',
        label: "Sunday",
    },
];

const FOLLOW_UP_BEHAVIOR_OPTIONS: Option<FollowUpBehavior>[] = [
    {
        id: 'steer',
        label: "Steer",
    },
    {
        id: 'queue',
        label: "Queue",
    },
];

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

type VisibleSetting = 'theme' | 'windowControlsPosition' | 'pwaInstallName' | 'pwaOrientation' | 'mobileKeyboardMode' | 'timeFormat' | 'weekStart' | 'fontSize' | 'terminalFontSize' | 'terminalShell' | 'terminalLoginShell' | 'editorFontSize' | 'spacing' | 'inputBarOffset' | 'mermaidRendering' | 'userMessageRendering' | 'chatRenderMode' | 'messageTransport' | 'activityRenderMode' | 'collapsibleUserMessages' | 'stickyUserHeader' | 'promptNavigatorEnabled' | 'wideChatLayout' | 'codeBlockLineWrap' | 'splitAssistantMessageActions' | 'subagentReadOnlyBanner' | 'diffLayout' | 'mobileStatusBar' | 'dotfiles' | 'fileViewerPreview' | 'reasoning' | 'showToolFileIcons' | 'showTurnChangedFiles' | 'expandedTools' | 'followUpBehavior' | 'terminalQuickKeys' | 'fileEditorKeymap' | 'persistDraft' | 'inputSpellcheck' | 'reportUsage' | 'expandedEditorToolbar' | 'autoSaveEnabled';

const WINDOW_CONTROLS_POSITION_OPTIONS: Array<{ id: DesktopWindowControlsPosition; label: string }> = [
    { id: 'left', label: "Left" },
    { id: 'right', label: "Right" },
];

const WINDOW_CONTROLS_STYLE_OPTIONS: Array<{ id: DesktopWindowControlsStyle; label: string }> = [
    { id: 'classic', label: "Classic" },
    { id: 'traffic-lights', label: "Traffic lights" },
];

interface PiChamberVisualSettingsProps {
    /** Which settings to show. If undefined, shows all. */
    visibleSettings?: VisibleSetting[];
}

export const PiChamberVisualSettings: React.FC<PiChamberVisualSettingsProps> = ({ visibleSettings }) => {
          const { isMobile } = useDeviceInfo();
    const { terminal } = useRuntimeAPIs();
    const { browserTab } = usePwaDetection();
    const directoryShowHidden = useDirectoryShowHidden();
    const showReasoningTraces = useUIStore(state => state.showReasoningTraces);
    const setShowReasoningTraces = useUIStore(state => state.setShowReasoningTraces);
    const collapsibleThinkingBlocks = useUIStore(state => state.collapsibleThinkingBlocks);
    const setCollapsibleThinkingBlocks = useUIStore(state => state.setCollapsibleThinkingBlocks);

    const mermaidRenderingMode = useUIStore(state => state.mermaidRenderingMode);
    const setMermaidRenderingMode = useUIStore(state => state.setMermaidRenderingMode);
    const userMessageRenderingMode = useUIStore(state => state.userMessageRenderingMode);
    const setUserMessageRenderingMode = useUIStore(state => state.setUserMessageRenderingMode);
    const collapsibleUserMessages = useUIStore(state => state.collapsibleUserMessages);
    const setCollapsibleUserMessages = useUIStore(state => state.setCollapsibleUserMessages);
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore(state => state.promptNavigatorEnabled);
    const setStickyUserHeader = useUIStore(state => state.setStickyUserHeader);
    const setPromptNavigatorEnabled = useUIStore(state => state.setPromptNavigatorEnabled);
    const expandedEditorToolbar = useUIStore(state => state.expandedEditorToolbar);
    const setExpandedEditorToolbar = useUIStore(state => state.setExpandedEditorToolbar);
    const autoSaveEnabled = useUIStore(state => state.autoSaveEnabled);
    const setAutoSaveEnabled = useUIStore(state => state.setAutoSaveEnabled);
    const wideChatLayoutEnabled = useUIStore(state => state.wideChatLayoutEnabled);
    const setWideChatLayoutEnabled = useUIStore(state => state.setWideChatLayoutEnabled);
    const codeBlockLineWrap = useUIStore(state => state.codeBlockLineWrap);
    const setCodeBlockLineWrap = useUIStore(state => state.setCodeBlockLineWrap);
    const chatRenderMode = useUIStore(state => state.chatRenderMode);
    const setChatRenderMode = useUIStore(state => state.setChatRenderMode);
    const activityRenderMode = useUIStore(state => state.activityRenderMode);
    const setActivityRenderMode = useUIStore(state => state.setActivityRenderMode);
    const fontSize = useUIStore(state => state.fontSize);
    const setFontSize = useUIStore(state => state.setFontSize);
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const setTerminalFontSize = useUIStore(state => state.setTerminalFontSize);
    const terminalShell = useUIStore(state => state.terminalShell);
    const setTerminalShell = useUIStore(state => state.setTerminalShell);
    const terminalLoginShells = useUIStore(state => state.terminalLoginShells);
    const setTerminalLoginShells = useUIStore(state => state.setTerminalLoginShells);
    const editorFontSize = useUIStore(state => state.editorFontSize);
    const setEditorFontSize = useUIStore(state => state.setEditorFontSize);
    const uiFont = useUIStore(state => state.uiFont);
    const setUiFont = useUIStore(state => state.setUiFont);
    const monoFont = useUIStore(state => state.monoFont);
    const setMonoFont = useUIStore(state => state.setMonoFont);
    const padding = useUIStore(state => state.padding);
    const setPadding = useUIStore(state => state.setPadding);
    const inputBarOffset = useUIStore(state => state.inputBarOffset);
    const setInputBarOffset = useUIStore(state => state.setInputBarOffset);
    const mobileKeyboardMode = useUIStore(state => state.mobileKeyboardMode);
    const setMobileKeyboardMode = useUIStore(state => state.setMobileKeyboardMode);
    const diffLayoutPreference = useUIStore(state => state.diffLayoutPreference);
    const setDiffLayoutPreference = useUIStore(state => state.setDiffLayoutPreference);
    const showTerminalQuickKeysOnDesktop = useUIStore(state => state.showTerminalQuickKeysOnDesktop);
    const setShowTerminalQuickKeysOnDesktop = useUIStore(state => state.setShowTerminalQuickKeysOnDesktop);
    const fileEditorKeymap = useUIStore(state => state.fileEditorKeymap);
    const setFileEditorKeymap = useUIStore(state => state.setFileEditorKeymap);
    const followUpBehavior = useMessageQueueStore(state => state.followUpBehavior);
    const setFollowUpBehavior = useMessageQueueStore(state => state.setFollowUpBehavior);
    const persistChatDraft = useUIStore(state => state.persistChatDraft);
    const setPersistChatDraft = useUIStore(state => state.setPersistChatDraft);
    const inputSpellcheckEnabled = useUIStore(state => state.inputSpellcheckEnabled);
    const setInputSpellcheckEnabled = useUIStore(state => state.setInputSpellcheckEnabled);
    const showToolFileIcons = useUIStore(state => state.showToolFileIcons);
    const setShowToolFileIcons = useUIStore(state => state.setShowToolFileIcons);
    const showTurnChangedFiles = useUIStore(state => state.showTurnChangedFiles);
    const setShowTurnChangedFiles = useUIStore(state => state.setShowTurnChangedFiles);
    const showExpandedBashTools = useUIStore(state => state.showExpandedBashTools);
    const setShowExpandedBashTools = useUIStore(state => state.setShowExpandedBashTools);
    const showExpandedEditTools = useUIStore(state => state.showExpandedEditTools);
    const setShowExpandedEditTools = useUIStore(state => state.setShowExpandedEditTools);
    const timeFormatPreference = useUIStore(state => state.timeFormatPreference);
    const setTimeFormatPreference = useUIStore(state => state.setTimeFormatPreference);
    const weekStartPreference = useUIStore(state => state.weekStartPreference);
    const setWeekStartPreference = useUIStore(state => state.setWeekStartPreference);
    const showSplitAssistantMessageActions = useUIStore(state => state.showSplitAssistantMessageActions);
    const setShowSplitAssistantMessageActions = useUIStore(state => state.setShowSplitAssistantMessageActions);
    const allowPromptingSubagentSessions = useUIStore(state => state.allowPromptingSubagentSessions);
    const setAllowPromptingSubagentSessions = useUIStore(state => state.setAllowPromptingSubagentSessions);
    const draftStartersVisible = useUIStore(state => state.draftStartersVisible);
    const setDraftStartersVisible = useUIStore(state => state.setDraftStartersVisible);
    const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport);
    const setMessageStreamTransport = useConfigStore((state) => state.setSettingsMessageStreamTransport);
    const effectiveMessageStreamTransport = messageStreamTransport;
    const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
    const setSettingsDefaultFileViewerPreview = useConfigStore((state) => state.setSettingsDefaultFileViewerPreview);
    const isSettingsDialogOpen = useUIStore(state => state.isSettingsDialogOpen);
    const {
        themeMode,
        setThemeMode,
        availableThemes,
        customThemesLoading,
        reloadCustomThemes,
        lightThemeId,
        darkThemeId,
        setLightThemePreference,
        setDarkThemePreference,
    } = useThemeSystem();

    const [themesReloading, setThemesReloading] = React.useState(false);

    // macOS-desktop-only dock badge that counts chats with unseen activity.
    // The tray sync (mac-only) pumps the count to the main process, so the
    // toggle is offered only where it actually has an effect. No relaunch needed.
    const dockBadgeSupported = React.useMemo(
        () => isDesktopShell() && typeof window !== 'undefined'
            && (window as unknown as { __PICHAMBER_PLATFORM__?: string }).__PICHAMBER_PLATFORM__ === 'darwin',
        [],
    );
    const dockBadgeEnabled = useUIStore(state => state.dockBadgeEnabled);
    const setDockBadgeEnabled = useUIStore(state => state.setDockBadgeEnabled);
    const showWindowControlsPosition = usesFramelessElectronChrome();
    const desktopWindowControlsPosition = useUIStore((state) => state.desktopWindowControlsPosition);
    const setDesktopWindowControlsPosition = useUIStore((state) => state.setDesktopWindowControlsPosition);
    const desktopWindowControlsStyle = useUIStore((state) => state.desktopWindowControlsStyle);
    const setDesktopWindowControlsStyle = useUIStore((state) => state.setDesktopWindowControlsStyle);
    const [chatRenderPreviewTick, setChatRenderPreviewTick] = React.useState(0);
    const reportUsage = useUIStore(state => state.reportUsage);
    const setReportUsage = useUIStore(state => state.setReportUsage);

    // Sync reportUsage changes to server settings
    const handleReportUsageChange = React.useCallback((enabled: boolean) => {
        setReportUsage(enabled);
        void updateDesktopSettings({ reportUsage: enabled });
    }, [setReportUsage]);

    const handleWindowControlsPositionChange = React.useCallback((value: DesktopWindowControlsPosition) => {
        setDesktopWindowControlsPosition(value);
        void updateDesktopSettings({ desktopWindowControlsPosition: value });
    }, [setDesktopWindowControlsPosition]);

    const handleWindowControlsStyleChange = React.useCallback((value: DesktopWindowControlsStyle) => {
        setDesktopWindowControlsStyle(value);
        void updateDesktopSettings({ desktopWindowControlsStyle: value });
    }, [setDesktopWindowControlsStyle]);

    const shouldAnimateChatPreview = (isSettingsDialogOpen || isMobile)
        && (visibleSettings ? visibleSettings.includes('chatRenderMode') : true);

    React.useEffect(() => {
        if (!shouldAnimateChatPreview) {
            return;
        }

        // Use requestAnimationFrame for smoother animation without setInterval overhead
        let rafId: number | null = null;
        let lastTime = Date.now();
        
        const tick = () => {
            const now = Date.now();
            // Update every ~420ms
            if (now - lastTime >= 420) {
                setChatRenderPreviewTick((prev) => (prev + 1) % 24);
                lastTime = now;
            }
            rafId = requestAnimationFrame(tick);
        };
        
        // Only run when visible
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
            rafId = requestAnimationFrame(tick);
        }
        
        const onVisibility = () => {
            if (document.visibilityState === 'visible' && rafId === null) {
                rafId = requestAnimationFrame(tick);
            } else if (document.visibilityState !== 'visible' && rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        };
        
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
        };
    }, [shouldAnimateChatPreview]);

    const handleUserMessageRenderingModeChange = React.useCallback((mode: 'markdown' | 'plain') => {
        setUserMessageRenderingMode(mode);
        void updateDesktopSettings({ userMessageRenderingMode: mode });
    }, [setUserMessageRenderingMode]);

    const handleStickyUserHeaderChange = React.useCallback((enabled: boolean) => {
        setStickyUserHeader(enabled);
        void updateDesktopSettings({ stickyUserHeader: enabled });
    }, [setStickyUserHeader]);

    const handlePromptNavigatorEnabledChange = React.useCallback((enabled: boolean) => {
        setPromptNavigatorEnabled(enabled);
        void updateDesktopSettings({ promptNavigatorEnabled: enabled });
    }, [setPromptNavigatorEnabled]);

    const handleDraftStartersVisibleChange = React.useCallback((enabled: boolean) => {
        setDraftStartersVisible(enabled);
        void updateDesktopSettings({ draftStartersVisible: enabled });
    }, [setDraftStartersVisible]);

    const handleExpandedEditorToolbarChange = React.useCallback((enabled: boolean) => {
        setExpandedEditorToolbar(enabled);
        void updateDesktopSettings({ expandedEditorToolbar: enabled });
    }, [setExpandedEditorToolbar]);

    const handleCollapsibleUserMessagesChange = React.useCallback((enabled: boolean) => {
        setCollapsibleUserMessages(enabled);
        void updateDesktopSettings({ collapsibleUserMessages: enabled });
    }, [setCollapsibleUserMessages]);

    const handleWideChatLayoutChange = React.useCallback((enabled: boolean) => {
        setWideChatLayoutEnabled(enabled);
        void updateDesktopSettings({ wideChatLayoutEnabled: enabled });
    }, [setWideChatLayoutEnabled]);

    const handleShowSplitAssistantMessageActionsChange = React.useCallback((enabled: boolean) => {
        setShowSplitAssistantMessageActions(enabled);
        void updateDesktopSettings({ showSplitAssistantMessageActions: enabled });
    }, [setShowSplitAssistantMessageActions]);

    const handleInputSpellcheckChange = React.useCallback((enabled: boolean) => {
        setInputSpellcheckEnabled(enabled);
        void updateDesktopSettings({ inputSpellcheckEnabled: enabled });
    }, [setInputSpellcheckEnabled]);

    const handleChatRenderModeChange = React.useCallback((mode: 'sorted' | 'live') => {
        setChatRenderMode(mode);
        void updateDesktopSettings({ chatRenderMode: mode });
    }, [setChatRenderMode]);

    const handleMessageStreamTransportChange = React.useCallback((mode: 'auto' | 'ws' | 'sse') => {
        setMessageStreamTransport(mode);
        void updateDesktopSettings({ messageStreamTransport: mode });
    }, [setMessageStreamTransport]);

    const handleActivityRenderModeChange = React.useCallback((mode: 'collapsed' | 'summary') => {
        setActivityRenderMode(mode);
        void updateDesktopSettings({ activityRenderMode: mode });
    }, [setActivityRenderMode]);

    const handleMermaidRenderingModeChange = React.useCallback((mode: 'svg' | 'ascii') => {
        setMermaidRenderingMode(mode);
        void updateDesktopSettings({ mermaidRenderingMode: mode });
    }, [setMermaidRenderingMode]);

    const handleShowToolFileIconsChange = React.useCallback((enabled: boolean) => {
        setShowToolFileIcons(enabled);
        void updateDesktopSettings({ showToolFileIcons: enabled });
    }, [setShowToolFileIcons]);

    const handleShowTurnChangedFilesChange = React.useCallback((enabled: boolean) => {
        setShowTurnChangedFiles(enabled);
        void updateDesktopSettings({ showTurnChangedFiles: enabled });
    }, [setShowTurnChangedFiles]);

    const handleFileViewerPreviewChange = React.useCallback((enabled: boolean) => {
        setSettingsDefaultFileViewerPreview(enabled);
        void updateDesktopSettings({ defaultFileViewerPreview: enabled });
        window.dispatchEvent(new CustomEvent('pichamber:file-viewer-preview-mode-changed', { detail: { enabled } }));
    }, [setSettingsDefaultFileViewerPreview]);

    const handleShowExpandedBashToolsChange = React.useCallback((enabled: boolean) => {
        setShowExpandedBashTools(enabled);
        void updateDesktopSettings({ showExpandedBashTools: enabled });
    }, [setShowExpandedBashTools]);

    const handleShowExpandedEditToolsChange = React.useCallback((enabled: boolean) => {
        setShowExpandedEditTools(enabled);
        void updateDesktopSettings({ showExpandedEditTools: enabled });
    }, [setShowExpandedEditTools]);

    const handleTimeFormatPreferenceChange = React.useCallback((value: 'auto' | '12h' | '24h') => {
        setTimeFormatPreference(value);
        void updateDesktopSettings({ timeFormatPreference: value });
    }, [setTimeFormatPreference]);

    const handleWeekStartPreferenceChange = React.useCallback((value: 'auto' | 'monday' | 'sunday') => {
        setWeekStartPreference(value);
        void updateDesktopSettings({ weekStartPreference: value });
    }, [setWeekStartPreference]);

    const lightThemes = React.useMemo(
        () => availableThemes
            .filter((theme) => theme.metadata.variant === 'light')
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
        [availableThemes],
    );

    const darkThemes = React.useMemo(
        () => availableThemes
            .filter((theme) => theme.metadata.variant === 'dark')
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
        [availableThemes],
    );

    const selectedLightTheme = React.useMemo(
        () => lightThemes.find((theme) => theme.metadata.id === lightThemeId) ?? lightThemes[0],
        [lightThemes, lightThemeId],
    );

    const selectedDarkTheme = React.useMemo(
        () => darkThemes.find((theme) => theme.metadata.id === darkThemeId) ?? darkThemes[0],
        [darkThemes, darkThemeId],
    );

    const formatThemeLabel = React.useCallback((themeName: string, variant: 'light' | 'dark') => {
        const suffix = variant === 'dark' ? ' Dark' : ' Light';
        return themeName.endsWith(suffix) ? themeName.slice(0, -suffix.length) : themeName;
    }, []);

    const shouldShow = (setting: VisibleSetting): boolean => {
        if (!visibleSettings) return true;
        return visibleSettings.includes(setting);
    };

    const hasThemeSettings = shouldShow('theme');
    const showWindowControlsPositionSetting = shouldShow('windowControlsPosition') && showWindowControlsPosition;
    const hasLocalizationSettings = shouldShow('theme') || shouldShow('timeFormat') || shouldShow('weekStart');
    const showMobileLayoutSetting = isMobile && isWebRuntime() && !isDesktopShell();
    const hasAppearanceSettings = (shouldShow('theme') || showWindowControlsPositionSetting || showMobileLayoutSetting || shouldShow('pwaInstallName') || shouldShow('pwaOrientation') || shouldShow('timeFormat') || shouldShow('weekStart'));
    const hasLayoutSettings = shouldShow('fontSize') || shouldShow('terminalFontSize') || shouldShow('editorFontSize') || shouldShow('spacing') || (shouldShow('inputBarOffset') && isMobile);
    const hasNavigationSettings = (shouldShow('terminalQuickKeys') && !isMobile) || ((shouldShow('terminalShell') || shouldShow('terminalLoginShell'))) || shouldShow('fileEditorKeymap') || shouldShow('autoSaveEnabled') || shouldShow('expandedEditorToolbar');
    const hasBehaviorSettings = shouldShow('mermaidRendering')
        || shouldShow('userMessageRendering')
        || shouldShow('chatRenderMode')
        || shouldShow('messageTransport')
        || (shouldShow('activityRenderMode') && chatRenderMode === 'sorted')
        || shouldShow('collapsibleUserMessages')
        || shouldShow('stickyUserHeader')
        || shouldShow('promptNavigatorEnabled')
        || shouldShow('wideChatLayout')
        || shouldShow('codeBlockLineWrap')
        || shouldShow('splitAssistantMessageActions')
        || shouldShow('subagentReadOnlyBanner')
        || shouldShow('diffLayout')
        || shouldShow('dotfiles')
        || shouldShow('fileViewerPreview')
        || shouldShow('reasoning')
        || shouldShow('followUpBehavior')
        || shouldShow('persistDraft')
        || shouldShow('showToolFileIcons')
        || shouldShow('expandedTools')
        || (!isMobile && shouldShow('inputSpellcheck'));
    const showBehaviorDisplaySettings = shouldShow('chatRenderMode')
        || (shouldShow('activityRenderMode') && chatRenderMode === 'sorted');
    const showTransportSection = shouldShow('messageTransport');
    const showBehaviorMessageOptions = shouldShow('userMessageRendering')
        || shouldShow('mermaidRendering')
        || shouldShow('diffLayout')
        || shouldShow('followUpBehavior');
    const showBehaviorFeatureCheckboxes = shouldShow('subagentReadOnlyBanner')
        || shouldShow('collapsibleUserMessages')
        || shouldShow('stickyUserHeader')
        || shouldShow('promptNavigatorEnabled')
        || shouldShow('wideChatLayout')
        || shouldShow('codeBlockLineWrap')
        || shouldShow('splitAssistantMessageActions')
        || shouldShow('dotfiles')
        || shouldShow('fileViewerPreview')
        || shouldShow('persistDraft')
        || shouldShow('showToolFileIcons')
        || shouldShow('showTurnChangedFiles')
        || (!isMobile && shouldShow('inputSpellcheck'))
        || shouldShow('reasoning')
        || shouldShow('expandedTools');
    // First behavior section under the page header should not draw a top border on Chat-only;
    // when Appearance (or earlier sections) already rendered, keep the default divider.
    const behaviorSectionDivider = hasAppearanceSettings || hasLayoutSettings || hasNavigationSettings;

    const showPwaInstallNameSetting = shouldShow('pwaInstallName') && isWebRuntime() && browserTab && !isDesktopShell();
    const showPwaOrientationSetting = shouldShow('pwaOrientation') && isWebRuntime() && !isDesktopShell();
    const showMobileKeyboardModeSetting = shouldShow('mobileKeyboardMode') && isWebRuntime() && !isDesktopShell() && supportsMobileKeyboardResizeContent();
    const showTerminalShellSetting = (shouldShow('terminalShell') || shouldShow('terminalLoginShell'));
    const [availableTerminalShells, setAvailableTerminalShells] = React.useState<TerminalShellOption[]>([]);
    const [terminalShellRuntimeEpoch, setTerminalShellRuntimeEpoch] = React.useState(0);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
        setAvailableTerminalShells([]);
        setTerminalShellRuntimeEpoch((epoch) => epoch + 1);
    }), []);
    React.useEffect(() => {
        let cancelled = false;
        if (!showTerminalShellSetting || !terminal.listShells) return;
        void terminal.listShells()
            .then((shells) => {
                if (!cancelled) setAvailableTerminalShells(shells);
            })
            .catch(() => {
                if (!cancelled) setAvailableTerminalShells([]);
            });
        return () => {
            cancelled = true;
        };
    }, [showTerminalShellSetting, terminal, terminalShellRuntimeEpoch]);
    const terminalShellOptions = React.useMemo(() => {
        const explicitShells = availableTerminalShells.filter((shell) => shell.id !== 'auto');
        if (terminalShell === 'auto' || explicitShells.some((shell) => shell.id === terminalShell)) {
            return explicitShells;
        }
        return [{ id: terminalShell, name: terminalShell, supportsLogin: false }, ...explicitShells];
    }, [availableTerminalShells, terminalShell]);
    const terminalShellSupportsLogin = availableTerminalShells.find((shell) => shell.id === terminalShell)?.supportsLogin === true;
    const terminalLoginShellEnabled = terminalLoginShells.includes(terminalShell);
    const setTerminalLoginShellEnabled = (enabled: boolean) => {
        setTerminalLoginShells(enabled
            ? [...terminalLoginShells.filter((shell) => shell !== terminalShell), terminalShell]
            : terminalLoginShells.filter((shell) => shell !== terminalShell));
    };
    const [mobileLayoutPreference, setMobileLayoutPreference] = React.useState<MobileLayoutPreference>(() => getStoredMobileLayoutPreference());
    const [pwaInstallName, setPwaInstallName] = React.useState('');
    const [pwaOrientation, setPwaOrientation] = React.useState<'system' | 'portrait' | 'landscape'>('system');
    const selectedTimeFormatLabel = React.useMemo(() => {
        const option = TIME_FORMAT_OPTIONS.find((item) => item.id === timeFormatPreference);
        return option?.label ?? 'Auto';
    }, [timeFormatPreference]);
    const selectedWeekStartLabel = React.useMemo(() => {
        const option = WEEK_START_OPTIONS.find((item) => item.id === weekStartPreference);
        return option?.label ?? 'Auto';
    }, [weekStartPreference]);
    const selectedPwaOrientationLabel = React.useMemo(() => {
        const option = PWA_ORIENTATION_OPTIONS.find((item) => item.id === pwaOrientation);
        return option ? option.label : undefined;
    }, [pwaOrientation]);
    const selectedMobileKeyboardModeLabel = React.useMemo(() => {
        const option = MOBILE_KEYBOARD_MODE_OPTIONS.find((item) => item.id === mobileKeyboardMode);
        return option ? option.label : undefined;
    }, [mobileKeyboardMode]);

    const handleMobileLayoutPreferenceChange = React.useCallback((value: MobileLayoutPreference) => {
        if (value === mobileLayoutPreference) {
            return;
        }

        setMobileLayoutPreference(value);
        setStoredMobileLayoutPreference(value);
        window.location.reload();
    }, [mobileLayoutPreference]);

    const applyPwaInstallName = React.useCallback(async (value: string) => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 64);
        const persistedValue = normalized;

        await updateDesktopSettings({ pwaAppName: persistedValue });

        if (typeof win.__PICHAMBER_SET_PWA_INSTALL_NAME__ === 'function') {
            const resolved = win.__PICHAMBER_SET_PWA_INSTALL_NAME__(persistedValue);
            setPwaInstallName(resolved);
            return;
        }

        setPwaInstallName(persistedValue || DEFAULT_PWA_INSTALL_NAME);
        win.__PICHAMBER_UPDATE_PWA_MANIFEST__?.();
    }, []);

    const applyPwaOrientation = React.useCallback(async (value: 'system' | 'portrait' | 'landscape') => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = normalizePwaOrientation(value);

        await updateDesktopSettings({ pwaOrientation: normalized });

        if (typeof win.__PICHAMBER_SET_PWA_ORIENTATION__ === 'function') {
            const resolved = win.__PICHAMBER_SET_PWA_ORIENTATION__(normalized);
            setPwaOrientation(resolved);
            return;
        }

        setPwaOrientation(normalized);
        win.__PICHAMBER_UPDATE_PWA_MANIFEST__?.();
    }, []);

    React.useEffect(() => {
        if (typeof window === 'undefined' || (!showPwaInstallNameSetting && !showPwaOrientationSetting && !showMobileKeyboardModeSetting)) {
            return;
        }

        let cancelled = false;

        const loadPwaInstallName = async () => {
            try {
                const response = await runtimeFetch('/api/pi/ui-settings', {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    cache: 'no-store',
                });

                if (!response.ok) {
                    if (!cancelled) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    return;
                }

                const settings = await response.json().catch(() => ({}));
                const raw = typeof settings?.pwaAppName === 'string' ? settings.pwaAppName : '';
                const normalized = raw.trim().replace(/\s+/g, ' ').slice(0, 64);
                const orientation = normalizePwaOrientation(settings?.pwaOrientation);
                const nextMobileKeyboardMode = normalizeMobileKeyboardMode(settings?.mobileKeyboardMode);

                if (!cancelled) {
                    if (showPwaInstallNameSetting) {
                        setPwaInstallName(normalized || DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientationSetting) {
                        setPwaOrientation(orientation);
                    }
                    if (showMobileKeyboardModeSetting) {
                        setMobileKeyboardMode(nextMobileKeyboardMode);
                    }
                }
            } catch {
                if (!cancelled) {
                    if (showPwaInstallNameSetting) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientationSetting) {
                        setPwaOrientation('system');
                    }
                    if (showMobileKeyboardModeSetting) {
                        setMobileKeyboardMode('native');
                    }
                }
            }
        };

        void loadPwaInstallName();

        return () => {
            cancelled = true;
        };
    }, [setMobileKeyboardMode, showMobileKeyboardModeSetting, showPwaInstallNameSetting, showPwaOrientationSetting]);

    return (
        <div className="space-y-0">

                {/* --- Appearance & Themes --- */}
                {hasAppearanceSettings && (
                    <div className="space-y-0">
                        {hasThemeSettings && (
                            <SettingsSection title={"Color mode & Theme"} divider={false}>
                                <SettingsTwoColumn>
                                    <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                        <SettingsRadioGroup aria-label={"Color Mode"}>
                                            {THEME_MODE_OPTIONS.map((option) => (
                                                <SettingsRadioOption
                                                    key={option.value}
                                                    selected={themeMode === option.value}
                                                    onSelect={() => setThemeMode(option.value)}
                                                    label={option.label}
                                                    ariaLabel={option.label}
                                                />
                                            ))}
                                        </SettingsRadioGroup>

                                        {showMobileLayoutSetting && (
                                            <SettingsInset>
                                                <SettingsStackedField label={"Mobile Layout"}>
                                                    <SettingsChipGroup
                                                        value={mobileLayoutPreference}
                                                        options={MOBILE_LAYOUT_OPTIONS.map((option) => ({
                                                            value: option.value,
                                                            label: option.label,
                                                        }))}
                                                        onChange={handleMobileLayoutPreferenceChange}
                                                        aria-label={"Mobile Layout"}
                                                    />
                                                </SettingsStackedField>
                                            </SettingsInset>
                                        )}
                                    </div>

                                    <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                        <SettingsStackedField
                                            label={"Light Theme"}
                                            settingsItem="appearance.light-theme"
                                        >
                                            <Select value={selectedLightTheme?.metadata.id ?? ''} onValueChange={setLightThemePreference}>
                                                <SelectTrigger aria-label={"Select light theme"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={"Select theme"}>
                                                        {selectedLightTheme
                                                            ? formatThemeLabel(selectedLightTheme.metadata.name, 'light')
                                                            : undefined}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {lightThemes.map((theme) => (
                                                        <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                                                            {formatThemeLabel(theme.metadata.name, 'light')}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </SettingsStackedField>
                                        <SettingsStackedField
                                            label={"Dark Theme"}
                                            settingsItem="appearance.dark-theme"
                                        >
                                            <Select value={selectedDarkTheme?.metadata.id ?? ''} onValueChange={setDarkThemePreference}>
                                                <SelectTrigger aria-label={"Select dark theme"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={"Select theme"}>
                                                        {selectedDarkTheme
                                                            ? formatThemeLabel(selectedDarkTheme.metadata.name, 'dark')
                                                            : undefined}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {darkThemes.map((theme) => (
                                                        <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                                                            {formatThemeLabel(theme.metadata.name, 'dark')}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </SettingsStackedField>

                                        <div className="flex items-center gap-2 pt-1">
                                            <button
                                                type="button"
                                                disabled={customThemesLoading || themesReloading}
                                                onClick={() => {
                                                    const startedAt = Date.now();
                                                    setThemesReloading(true);
                                                    void reloadCustomThemes().finally(() => {
                                                        const elapsed = Date.now() - startedAt;
                                                        if (elapsed < 500) {
                                                            window.setTimeout(() => {
                                                                setThemesReloading(false);
                                                            }, 500 - elapsed);
                                                            return;
                                                        }
                                                        setThemesReloading(false);
                                                    });
                                                }}
                                                className="typography-settings-link inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
                                            >
                                                <Icon name="restart" className={cn('h-3.5 w-3.5', themesReloading && 'animate-spin')} />
                                                {themesReloading ? "Reloading themes..." : "Reload themes"}
                                            </button>
                                            <SettingsInfoHint>
                                                {"Import custom themes from ~/.config/pichamber/themes/"}
                                            </SettingsInfoHint>
                                        </div>
                                    </div>
                                </SettingsTwoColumn>

                                {dockBadgeSupported && (
                                    <SettingsInset settingsItem="appearance.dock-badge">
                                        <SettingsCheckboxRow
                                            checked={dockBadgeEnabled}
                                            onChange={setDockBadgeEnabled}
                                            label={"Dock badge"}
                                            info={"Show a count of chats with unseen activity on the macOS dock icon."}
                                            ariaLabel={"Dock badge"}
                                        />
                                    </SettingsInset>
                                )}
                            </SettingsSection>
                        )}

                        {showWindowControlsPositionSetting && (
                            <SettingsSection
                                title={"Window controls"}
                                info={"Choose where minimize, maximize, and close buttons appear. Defaults to the right."}
                                divider={hasThemeSettings}
                            >
                                <SettingsTwoColumn>
                                    <SettingsStackedField
                                        label={"Window controls position"}
                                        settingsItem="sessions.desktop-window-controls-position"
                                    >
                                        <SettingsChipGroup
                                            value={desktopWindowControlsPosition}
                                            options={WINDOW_CONTROLS_POSITION_OPTIONS.map((option) => ({
                                                value: option.id,
                                                label: option.label,
                                            }))}
                                            onChange={handleWindowControlsPositionChange}
                                            aria-label={"Window controls position"}
                                        />
                                    </SettingsStackedField>
                                    <SettingsStackedField
                                        label={"Style"}
                                        settingsItem="sessions.desktop-window-controls-style"
                                    >
                                        <SettingsChipGroup
                                            value={desktopWindowControlsStyle}
                                            options={WINDOW_CONTROLS_STYLE_OPTIONS.map((option) => ({
                                                value: option.id,
                                                label: option.label,
                                            }))}
                                            onChange={handleWindowControlsStyleChange}
                                            aria-label={"Window controls style"}
                                        />
                                    </SettingsStackedField>
                                </SettingsTwoColumn>
                            </SettingsSection>
                        )}

                        {hasLocalizationSettings && (
                            <SettingsSection title={"Localization"}>
                                <SettingsTwoColumn>
                                    {(shouldShow('timeFormat') || shouldShow('weekStart')) && (
                                        <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                            {shouldShow('timeFormat') && (
                                                <SettingsStackedField
                                                    label={"Time Format"}
                                                    settingsItem="appearance.time-format"
                                                >
                                                    <Select value={timeFormatPreference} onValueChange={(value: 'auto' | '12h' | '24h') => handleTimeFormatPreferenceChange(value)}>
                                                        <SelectTrigger aria-label={"Select time format"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                            <SelectValue>{selectedTimeFormatLabel}</SelectValue>
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {TIME_FORMAT_OPTIONS.map((option) => (
                                                                <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </SettingsStackedField>
                                            )}

                                            {shouldShow('weekStart') && (
                                                <SettingsStackedField
                                                    label={"Week Starts On"}
                                                    settingsItem="appearance.week-start"
                                                >
                                                    <Select value={weekStartPreference} onValueChange={(value: 'auto' | 'monday' | 'sunday') => handleWeekStartPreferenceChange(value)}>
                                                        <SelectTrigger aria-label={"Select week start"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                            <SelectValue>{selectedWeekStartLabel}</SelectValue>
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {WEEK_START_OPTIONS.map((option) => (
                                                                <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </SettingsStackedField>
                                            )}
                                        </div>
                                    )}
                                </SettingsTwoColumn>
                            </SettingsSection>
                        )}

                        {(showPwaInstallNameSetting || showPwaOrientationSetting || showMobileKeyboardModeSetting) && (
                            <SettingsSection title={"App install"} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>

                            {showPwaInstallNameSetting && (
                                <SettingsFieldRow
                                    label={"Install App Name"}
                                    info={"Used by PWA installation process."}
                                    settingsItem="appearance.pwa-install-name"
                                    alignEnd={false}
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
                                    <Input
                                        value={pwaInstallName}
                                        onChange={(event) => {
                                            setPwaInstallName(event.target.value);
                                        }}
                                        onBlur={() => {
                                            void applyPwaInstallName(pwaInstallName);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                void applyPwaInstallName(pwaInstallName);
                                            }
                                        }}
                                        className="min-w-0 flex-1"
                                        maxLength={64}
                                        aria-label={"PWA install app name"}
                                    />
                                    <Button size="sm"
                                        type="button"
                                        variant="ghost"
                                        onClick={() => {
                                            setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                                            void applyPwaInstallName('');
                                        }}
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={"Reset install app name"}
                                        title={"Reset"}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsFieldRow>
                            )}

                            {showPwaOrientationSetting && (
                                <SettingsFieldRow
                                    label={"Install Orientation"}
                                    description={"Used by the installed web app. Reinstall the PWA after changing this."}
                                    settingsItem="appearance.pwa-orientation"
                                    alignEnd={false}
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
                                    <Select
                                        value={pwaOrientation}
                                        onValueChange={(value) => {
                                            const orientation = normalizePwaOrientation(value);
                                            setPwaOrientation(orientation);
                                            void applyPwaOrientation(orientation);
                                        }}
                                    >
                                        <SelectTrigger aria-label={"PWA install orientation"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_CLUSTER_CONTROL_CLASS}>
                                            <SelectValue placeholder={"Select orientation"}>
                                                {selectedPwaOrientationLabel}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent>
                                            {PWA_ORIENTATION_OPTIONS.map((option) => (
                                                <SelectItem key={option.id} value={option.id}>
                                                    {option.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Button size="sm"
                                        type="button"
                                        variant="ghost"
                                        onClick={() => {
                                            setPwaOrientation('system');
                                            void applyPwaOrientation('system');
                                        }}
                                        disabled={pwaOrientation === 'system'}
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={"Reset install orientation"}
                                        title={"Reset"}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsFieldRow>
                            )}

                            {showMobileKeyboardModeSetting && (
                                <SettingsFieldRow
                                    label={"Mobile Keyboard Behavior"}
                                    info={"Default browser behavior is safest. Resize content asks supported browsers to shrink the app when the on-screen keyboard opens."}
                                    settingsItem="appearance.mobile-keyboard-mode"
                                    alignEnd={false}
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
                                    <Select
                                        value={mobileKeyboardMode}
                                        onValueChange={(value) => {
                                            const mode = normalizeMobileKeyboardMode(value);
                                            setMobileKeyboardMode(mode);
                                            void updateDesktopSettings({ mobileKeyboardMode: mode });
                                        }}
                                    >
                                        <SelectTrigger aria-label={"Mobile keyboard behavior"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_CLUSTER_CONTROL_CLASS}>
                                            <SelectValue placeholder={"Select keyboard behavior"}>
                                                {selectedMobileKeyboardModeLabel}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent>
                                            {MOBILE_KEYBOARD_MODE_OPTIONS.map((option) => (
                                                <SelectItem key={option.id} value={option.id}>
                                                    {option.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Button size="sm"
                                        type="button"
                                        variant="ghost"
                                        onClick={() => {
                                            setMobileKeyboardMode('native');
                                            void updateDesktopSettings({ mobileKeyboardMode: 'native' });
                                        }}
                                        disabled={mobileKeyboardMode === 'native'}
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={"Reset mobile keyboard behavior"}
                                        title={"Reset"}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsFieldRow>
                            )}
                            </SettingsSection>
                        )}
                    </div>
                )}

                {/* --- Density & type --- */}
                {hasLayoutSettings && (
                    <SettingsSection title={"Density & type"} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>
                        {(shouldShow('fontSize') && !isMobile) || shouldShow('terminalFontSize') ? (
                            <SettingsTwoColumn>
                                {shouldShow('fontSize') && !isMobile && (
                                    <SettingsStackedField
                                        label={"Interface Font"}
                                        settingsItem="appearance.interface-font-size"
                                        controlClassName="w-full"
                                    >
                                        <Select value={uiFont} onValueChange={(value) => setUiFont(value as UiFontOption)}>
                                            <SelectTrigger aria-label={"Select interface font"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                <SelectValue>{UI_FONT_OPTIONS.find((option) => option.id === uiFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {UI_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setUiFont(DEFAULT_UI_FONT)}
                                            disabled={uiFont === DEFAULT_UI_FONT}
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={"Reset interface font"}
                                            title={"Reset"}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('terminalFontSize') && (
                                    <SettingsStackedField
                                        label={"Code Font"}
                                        controlClassName="w-full"
                                    >
                                        <Select value={monoFont} onValueChange={(value) => setMonoFont(value as MonoFontOption)}>
                                            <SelectTrigger aria-label={"Select code font"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                <SelectValue>{CODE_FONT_OPTIONS.find((option) => option.id === monoFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {CODE_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setMonoFont(DEFAULT_MONO_FONT)}
                                            disabled={monoFont === DEFAULT_MONO_FONT}
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={"Reset code font"}
                                            title={"Reset"}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}

                        {(shouldShow('fontSize') && !isMobile) || shouldShow('terminalFontSize') || shouldShow('editorFontSize') ? (
                            <SettingsTwoColumn>
                                {shouldShow('fontSize') && !isMobile && (
                                    <SettingsStackedField
                                        label={"Interface Font Size"}
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={fontSize}
                                                onValueChange={setFontSize}
                                                min={50}
                                                max={200}
                                                step={5}
                                                aria-label={"Font size percentage"}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>%</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setFontSize(100)}
                                                disabled={fontSize === 100}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={"Reset font size"}
                                                title={"Reset"}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('terminalFontSize') && (
                                    <SettingsStackedField
                                        label={"Terminal Font Size"}
                                        settingsItem="appearance.terminal-font-size"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={terminalFontSize}
                                                onValueChange={setTerminalFontSize}
                                                min={9}
                                                max={52}
                                                step={1}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setTerminalFontSize(13)}
                                                disabled={terminalFontSize === 13}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={"Reset terminal font size"}
                                                title={"Reset"}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('editorFontSize') && (
                                    <SettingsStackedField
                                        label={"Editor Font Size"}
                                        settingsItem="appearance.editor-font-size"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={editorFontSize}
                                                onValueChange={setEditorFontSize}
                                                min={9}
                                                max={32}
                                                step={1}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setEditorFontSize(13)}
                                                disabled={editorFontSize === 13}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={"Reset editor font size"}
                                                title={"Reset"}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}

                        {shouldShow('spacing') || (shouldShow('inputBarOffset') && isMobile) ? (
                            <SettingsTwoColumn>
                                {shouldShow('spacing') && (
                                    <SettingsStackedField
                                        label={"Spacing Density"}
                                        settingsItem="appearance.spacing-density"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={padding}
                                                onValueChange={setPadding}
                                                min={50}
                                                max={200}
                                                step={5}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>%</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setPadding(100)}
                                                disabled={padding === 100}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={"Reset spacing"}
                                                title={"Reset"}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('inputBarOffset') && isMobile && (
                                    <SettingsStackedField
                                        label={"Input Bar Offset"}
                                        info={"Raise input bar to avoid OS-level screen obstructions like home bars."}
                                        settingsItem="appearance.input-bar-offset"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={inputBarOffset}
                                                onValueChange={setInputBarOffset}
                                                min={0}
                                                max={100}
                                                step={5}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setInputBarOffset(0)}
                                                disabled={inputBarOffset === 0}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={"Reset input bar offset"}
                                                title={"Reset"}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}
                    </SettingsSection>
                )}

                {/* --- Navigation --- */}
                {hasNavigationSettings && (
                    <SettingsSection title={"Navigation"} contentClassName="space-y-4">
                        {shouldShow('fileEditorKeymap') && (
                            <SettingsControlGroup
                                title={"File editor keymap"}
                                settingsItem="appearance.file-editor-keymap"
                            >
                                <SettingsRadioGroup aria-label={"File editor keymap"}>
                                    {(['default', 'vim'] as const).map((keymap) => (
                                        <SettingsRadioOption
                                            key={keymap}
                                            selected={fileEditorKeymap === keymap}
                                            onSelect={() => setFileEditorKeymap(keymap)}
                                            label={keymap === 'default' ? 'Default' : 'Vim'}
                                            ariaLabel={keymap === 'default' ? 'Default' : 'Vim'}
                                        />
                                    ))}
                                </SettingsRadioGroup>
                            </SettingsControlGroup>
                        )}
                        <div className={SETTINGS_OPTION_STACK_CLASS}>
                            {shouldShow('autoSaveEnabled') && (
                                <SettingsCheckboxRow
                                    checked={autoSaveEnabled}
                                    onChange={setAutoSaveEnabled}
                                    label={"Auto-save files"}
                                    ariaLabel={"Auto-save files"}
                                    info={"Automatically save file edits after you stop typing. Disable to require manual save."}
                                    settingsItem="appearance.auto-save-enabled"
                                />
                            )}
                            {shouldShow('expandedEditorToolbar') && (
                                <SettingsCheckboxRow
                                    checked={expandedEditorToolbar}
                                    onChange={handleExpandedEditorToolbarChange}
                                    label={"Always show editor toolbar (docked under the file tabs)"}
                                    ariaLabel={"Always show editor toolbar"}
                                    settingsItem="appearance.expanded-editor-toolbar"
                                />
                            )}
                            {shouldShow('terminalQuickKeys') && !isMobile && (
                                <SettingsCheckboxRow
                                    checked={showTerminalQuickKeysOnDesktop}
                                    onChange={setShowTerminalQuickKeysOnDesktop}
                                    label={"Terminal Quick Keys"}
                                    ariaLabel={"Terminal quick keys"}
                                    settingsItem="appearance.terminal-quick-keys"
                                    info={"Show Esc, Ctrl, Arrows in terminal view"}
                                />
                            )}
                            {showTerminalShellSetting && (
                                <SettingsStackedField
                                    label={"Terminal Shell"}
                                    info={"Restart the terminal to apply this change to the current session."}
                                    settingsItem="appearance.terminal-shell"
                                    className="pt-2"
                                >
                                    <Select value={terminalShell} onValueChange={(value) => { if (isTerminalShell(value)) setTerminalShell(value); }}>
                                        <SelectTrigger aria-label={"Select terminal shell"} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="auto">{"Auto"}</SelectItem>
                                            {terminalShellOptions.map((shell) => (
                                                <SelectItem key={shell.id} value={shell.id}>{shell.name}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingsStackedField>
                            )}
                            {showTerminalShellSetting && terminalShellSupportsLogin && (
                                <SettingsCheckboxRow
                                    checked={terminalLoginShellEnabled}
                                    onChange={setTerminalLoginShellEnabled}
                                    label={"Start as login shell"}
                                    ariaLabel={"Start as login shell"}
                                    settingsItem="appearance.terminal-login-shell"
                                />
                            )}
                        </div>
                    </SettingsSection>
                )}

                {hasBehaviorSettings && (
                    <>
                        {showBehaviorDisplaySettings && (
                            <SettingsSection
                                title={"Display"}
                                divider={behaviorSectionDivider}
                                contentClassName="space-y-6"
                            >
                                {shouldShow('chatRenderMode') && (
                                    <SettingsControlGroup
                                        title={"Chat Render Mode"}
                                        settingsItem="chat.render-mode"
                                    >
                                        <div role="radiogroup" aria-label={"Chat render mode"} className="grid w-full max-w-[26rem] grid-cols-1 gap-3 @xl:grid-cols-2">
                                            {CHAT_RENDER_MODE_OPTIONS.map((option) => {
                                                const selected = chatRenderMode === option.id;
                                                const previewPhase = chatRenderPreviewTick % 12;
                                                return (
                                                    <button
                                                        key={option.id}
                                                        type="button"
                                                        onClick={() => handleChatRenderModeChange(option.id)}
                                                        aria-pressed={selected}
                                                        className={cn(
                                                            'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                                                            selected
                                                                ? 'border-primary bg-primary/5'
                                                                : 'border-border hover:border-border/80 hover:bg-muted/50'
                                                        )}
                                                    >
                                                        <span className={cn('typography-ui-label', selected ? 'text-foreground' : 'text-muted-foreground')}>
                                                            {option.label}
                                                        </span>
                                                        <div className="mt-2 w-full rounded-md border border-border/60 bg-muted/30 p-2">
                                                            {option.id === 'live' ? (
                                                                <div className="space-y-1.5">
                                                                    {[0, 1, 2].map((index) => {
                                                                        const rowStart = index * 3 + 1;
                                                                        const rowProgressPhase = previewPhase - rowStart + 1;
                                                                        const rowProgress = rowProgressPhase <= 0
                                                                            ? 0
                                                                            : rowProgressPhase === 1
                                                                                ? 42
                                                                                : rowProgressPhase === 2
                                                                                    ? 68
                                                                                    : 92;
                                                                        const visible = rowProgress > 0;
                                                                        return (
                                                                            <div
                                                                                key={index}
                                                                                className={cn(
                                                                                    'flex items-center gap-1.5 transition-all duration-300 motion-reduce:transition-none',
                                                                                    visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                                                                                )}
                                                                            >
                                                                                <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/55" />
                                                                                <span
                                                                                    className="h-1.5 rounded bg-muted-foreground/30 transition-all duration-300 motion-reduce:transition-none"
                                                                                    style={{ width: `${rowProgress}%` }}
                                                                                />
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            ) : (
                                                                <div className="space-y-1.5">
                                                                    {[0, 1, 2].map((index) => {
                                                                        const visible = previewPhase >= (index + 1) * 3;
                                                                        return (
                                                                            <div
                                                                                key={index}
                                                                                className={cn(
                                                                                    'flex items-center gap-1.5 transition-all duration-300 motion-reduce:transition-none',
                                                                                    visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                                                                                )}
                                                                            >
                                                                                <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/55" />
                                                                                <span
                                                                                    className="h-1.5 rounded bg-muted-foreground/30"
                                                                                    style={{ width: '92%' }}
                                                                                />
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </SettingsControlGroup>
                                )}

                                {shouldShow('activityRenderMode') && chatRenderMode === 'sorted' && (
                                    <SettingsControlGroup title={"Activity Default"}>
                                        <SettingsRadioGroup aria-label={"Activity default mode"}>
                                            {ACTIVITY_RENDER_MODE_OPTIONS.map((option) => (
                                                <SettingsRadioOption
                                                    key={option.id}
                                                    selected={activityRenderMode === option.id}
                                                    onSelect={() => handleActivityRenderModeChange(option.id)}
                                                    label={option.label}
                                                    ariaLabel={`Activity default mode: ${option.label}`}
                                                />
                                            ))}
                                        </SettingsRadioGroup>
                                    </SettingsControlGroup>
                                )}
                            </SettingsSection>
                        )}

                        {showTransportSection && (
                            <SettingsSection
                                title={"Message Stream Transport"}
                                divider={showBehaviorDisplaySettings || behaviorSectionDivider}
                                settingsItem="chat.message-transport"
                                contentClassName="space-y-2"
                            >
                                <SettingsChipGroup
                                    value={effectiveMessageStreamTransport}
                                    options={MESSAGE_STREAM_TRANSPORT_OPTIONS.map((option) => ({
                                        value: option.id,
                                        label: option.label,
                                    }))}
                                    onChange={handleMessageStreamTransportChange}
                                    aria-label={"Message Stream Transport"}
                                />
                                {(() => {
                                    const option = MESSAGE_STREAM_TRANSPORT_OPTIONS.find((item) => item.id === effectiveMessageStreamTransport);
                                    return option?.description ? (
                                        <span className="typography-meta text-muted-foreground">
                                            {option.description}
                                        </span>
                                    ) : null;
                                })()}
                            </SettingsSection>
                        )}

                        {showBehaviorMessageOptions && (
                            <SettingsSection
                                title={"Message options"}
                                divider={showBehaviorDisplaySettings || showTransportSection || behaviorSectionDivider}
                            >
                                {/* Flat 2×2 grid so row headers share a baseline (not stacked columns). */}
                                <SettingsTwoColumn className="lg:gap-y-6">
                                    {shouldShow('userMessageRendering') && (
                                        <SettingsControlGroup title={"User Message Rendering"}>
                                            <SettingsRadioGroup aria-label={"User message rendering mode"}>
                                                {USER_MESSAGE_RENDERING_OPTIONS.map((option) => (
                                                    <SettingsRadioOption
                                                        key={option.id}
                                                        selected={normalizeUserMessageRenderingMode(userMessageRenderingMode) === option.id}
                                                        onSelect={() => handleUserMessageRenderingModeChange(option.id)}
                                                        label={option.label}
                                                        ariaLabel={`User message rendering: ${option.label}`}
                                                    />
                                                ))}
                                            </SettingsRadioGroup>
                                        </SettingsControlGroup>
                                    )}

                                    {shouldShow('mermaidRendering') && (
                                        <SettingsControlGroup title={"Mermaid Rendering"}>
                                            <SettingsRadioGroup aria-label={"Mermaid rendering mode"}>
                                                {MERMAID_RENDERING_OPTIONS.map((option) => (
                                                    <SettingsRadioOption
                                                        key={option.id}
                                                        selected={mermaidRenderingMode === option.id}
                                                        onSelect={() => handleMermaidRenderingModeChange(option.id)}
                                                        label={option.label}
                                                        ariaLabel={`Mermaid rendering: ${option.label}`}
                                                    />
                                                ))}
                                            </SettingsRadioGroup>
                                        </SettingsControlGroup>
                                    )}

                                    {shouldShow('diffLayout') && (
                                        <SettingsControlGroup title={"Diff Layout"}>
                                            <SettingsRadioGroup aria-label={"Diff layout"}>
                                                {DIFF_LAYOUT_OPTIONS.map((option) => (
                                                    <SettingsRadioOption
                                                        key={option.id}
                                                        selected={diffLayoutPreference === option.id}
                                                        onSelect={() => setDiffLayoutPreference(option.id)}
                                                        label={option.label}
                                                        ariaLabel={`Diff layout: ${option.label}`}
                                                    />
                                                ))}
                                            </SettingsRadioGroup>
                                        </SettingsControlGroup>
                                    )}

                                    {shouldShow('followUpBehavior') && (
                                        <SettingsControlGroup
                                            title={"Follow-up behavior"}
                                            settingsItem="chat.follow-up-behavior"
                                        >
                                            <SettingsRadioGroup aria-label={"Follow-up behavior"}>
                                                {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                                                    <SettingsRadioOption
                                                        key={option.id}
                                                        selected={followUpBehavior === option.id}
                                                        onSelect={() => setFollowUpBehavior(option.id)}
                                                        label={option.label}
                                                        ariaLabel={`Follow-up behavior: ${option.label}`}
                                                    />
                                                ))}
                                            </SettingsRadioGroup>
                                        </SettingsControlGroup>
                                    )}
                                </SettingsTwoColumn>
                            </SettingsSection>
                        )}

                        {showBehaviorFeatureCheckboxes && (
                            <>
                                {shouldShow('expandedTools') && (
                                    <SettingsSection
                                        title={"Show tools opened by default"}
                                        divider={showBehaviorDisplaySettings || showTransportSection || showBehaviorMessageOptions || behaviorSectionDivider}
                                        contentClassName={SETTINGS_OPTION_STACK_CLASS}
                                    >
                                        <SettingsCheckboxRow
                                            checked={showExpandedBashTools}
                                            onChange={handleShowExpandedBashToolsChange}
                                            label={"Bash"}
                                            ariaLabel={"Show expanded bash tools"}
                                        />
                                        <SettingsCheckboxRow
                                            checked={showExpandedEditTools}
                                            onChange={handleShowExpandedEditToolsChange}
                                            label={"Edit tools"}
                                            ariaLabel={"Show expanded edit tools"}
                                        />
                                    </SettingsSection>
                                )}
                                <SettingsSection
                                    title={"Features"}
                                    contentClassName={SETTINGS_OPTION_STACK_CLASS}
                                >
                                    <SettingsCheckboxRow
                                        checked={draftStartersVisible}
                                        onChange={handleDraftStartersVisibleChange}
                                        label={"Show Starters on New Session Screen"}
                                        ariaLabel={"Show starters on the new session screen"}
                                        settingsItem="chat.draft-starters-visible"
                                    />
                                    {shouldShow('subagentReadOnlyBanner') && (
                                        <SettingsCheckboxRow
                                            checked={allowPromptingSubagentSessions}
                                            onChange={setAllowPromptingSubagentSessions}
                                            label={"Allow Prompting Subagent Sessions"}
                                            ariaLabel={"Allow prompting subagent sessions"}
                                            settingsItem="chat.subagent-read-only-banner"
                                        />
                                    )}
                                </SettingsSection>
                                {shouldShow('reasoning') && (
                                    <SettingsSection
                                        title={"Reasoning"}
                                        settingsItem="chat.reasoning"
                                        contentClassName={SETTINGS_OPTION_STACK_CLASS}
                                    >
                                        <SettingsCheckboxRow
                                            checked={showReasoningTraces}
                                            onChange={setShowReasoningTraces}
                                            label={"Show Reasoning Traces"}
                                            ariaLabel={"Show reasoning traces"}
                                            settingsItem="chat.reasoning-traces"
                                        />
                                        {showReasoningTraces && (
                                            <SettingsCheckboxRow
                                                checked={collapsibleThinkingBlocks}
                                                onChange={setCollapsibleThinkingBlocks}
                                                label={"Enable Collapsible Reasoning Blocks"}
                                                ariaLabel={"Enable collapsible reasoning blocks"}
                                            />
                                        )}
                                    </SettingsSection>
                                )}

                                {(shouldShow('collapsibleUserMessages') || shouldShow('stickyUserHeader') || shouldShow('promptNavigatorEnabled') || shouldShow('wideChatLayout') || shouldShow('splitAssistantMessageActions') || shouldShow('codeBlockLineWrap')) && (
                                <SettingsSection
                                    title={"Message Appearance"}
                                    settingsItem="chat.message-appearance"
                                    contentClassName={SETTINGS_OPTION_STACK_CLASS}
                                >
                                {shouldShow('collapsibleUserMessages') && (
                                    <SettingsCheckboxRow
                                        checked={collapsibleUserMessages}
                                        onChange={handleCollapsibleUserMessagesChange}
                                        label={"Collapse Long User Messages"}
                                        ariaLabel={"Collapse long user messages"}
                                        settingsItem="chat.collapsible-user-messages"
                                    />
                                )}

                                {shouldShow('stickyUserHeader') && (
                                    <SettingsCheckboxRow
                                        checked={stickyUserHeader}
                                        onChange={handleStickyUserHeaderChange}
                                        label={"Sticky User Header"}
                                        ariaLabel={"Sticky user header"}
                                        settingsItem="chat.sticky-user-header"
                                    />
                                )}

                                {shouldShow('promptNavigatorEnabled') && (
                                    <SettingsCheckboxRow
                                        checked={promptNavigatorEnabled}
                                        onChange={handlePromptNavigatorEnabledChange}
                                        label={"Prompt Navigator"}
                                        ariaLabel={"Prompt navigator"}
                                        settingsItem="chat.prompt-navigator"
                                    />
                                )}

                                {shouldShow('wideChatLayout') && (
                                    <SettingsCheckboxRow
                                        checked={wideChatLayoutEnabled}
                                        onChange={handleWideChatLayoutChange}
                                        label={"Wide Chat Layout"}
                                        ariaLabel={"Wide chat layout"}
                                        settingsItem="chat.wide-layout"
                                    />
                                )}

                                {shouldShow('splitAssistantMessageActions') && (
                                    <SettingsCheckboxRow
                                        checked={showSplitAssistantMessageActions}
                                        onChange={handleShowSplitAssistantMessageActionsChange}
                                        label={"Inline Assistant Actions"}
                                        ariaLabel={"Inline assistant actions"}
                                        settingsItem="chat.inline-assistant-actions"
                                        info={"Show Copy Answer, Save as image, and Read aloud on assistant text blocks that appear before later tool calls in the same response."}
                                    />
                                )}

                                {shouldShow('codeBlockLineWrap') && (
                                    <SettingsCheckboxRow
                                        checked={codeBlockLineWrap}
                                        onChange={setCodeBlockLineWrap}
                                        label={"Wrap Code Block Lines"}
                                        ariaLabel={"Wrap code block lines"}
                                        settingsItem="chat.code-block-line-wrap"
                                    />
                                )}
                                </SettingsSection>
                                )}

                                {(shouldShow('showToolFileIcons') || shouldShow('showTurnChangedFiles') || shouldShow('dotfiles') || shouldShow('fileViewerPreview')) && (
                                <SettingsSection
                                    title={"Tools & Files"}
                                    settingsItem="chat.tools-and-files"
                                    contentClassName={SETTINGS_OPTION_STACK_CLASS}
                                >
                                {shouldShow('showToolFileIcons') && (
                                    <SettingsCheckboxRow
                                        checked={showToolFileIcons}
                                        onChange={handleShowToolFileIconsChange}
                                        label={"Show Tool File Icons"}
                                        ariaLabel={"Show tool file icons"}
                                        settingsItem="chat.tool-file-icons"
                                    />
                                )}

                                {shouldShow('showTurnChangedFiles') && (
                                    <SettingsCheckboxRow
                                        checked={showTurnChangedFiles}
                                        onChange={handleShowTurnChangedFilesChange}
                                        label={"Show Changed Files for Completed Turns"}
                                        ariaLabel={"Show changed files for completed turns"}
                                        settingsItem="chat.changed-files"
                                    />
                                )}

                                {shouldShow('dotfiles') && (
                                    <SettingsCheckboxRow
                                        checked={directoryShowHidden}
                                        onChange={setDirectoryShowHidden}
                                        label={"Show Dotfiles"}
                                        ariaLabel={"Show dotfiles"}
                                        settingsItem="chat.dotfiles"
                                    />
                                )}

                                {shouldShow('fileViewerPreview') && (
                                    <SettingsCheckboxRow
                                        checked={settingsDefaultFileViewerPreview}
                                        onChange={handleFileViewerPreviewChange}
                                        label={"Open previewable files in preview mode"}
                                        ariaLabel={"Open previewable files in preview mode"}
                                    />
                                )}
                                </SettingsSection>
                                )}

                                {(shouldShow('persistDraft') || (!isMobile && shouldShow('inputSpellcheck'))) && (
                                <SettingsSection
                                    title={"Composer"}
                                    settingsItem="chat.composer"
                                    contentClassName={SETTINGS_OPTION_STACK_CLASS}
                                >
                                {shouldShow('persistDraft') && (
                                    <SettingsCheckboxRow
                                        checked={persistChatDraft}
                                        onChange={setPersistChatDraft}
                                        label={"Persist Draft Messages"}
                                        ariaLabel={"Persist draft messages"}
                                        settingsItem="chat.persist-drafts"
                                    />
                                )}

                                {!isMobile && shouldShow('inputSpellcheck') && (
                                    <SettingsCheckboxRow
                                        checked={inputSpellcheckEnabled}
                                        onChange={handleInputSpellcheckChange}
                                        label={"Enable Spellcheck in Text Inputs"}
                                        ariaLabel={"Enable spellcheck in text inputs"}
                                        settingsItem="chat.spellcheck"
                                    />
                                )}
                                </SettingsSection>
                                )}
                            </>
                        )}
                    </>
                )}

                {/* --- Privacy & Data --- */}
                {shouldShow('reportUsage') && (
                    <SettingsSection title={"Privacy"}>
                        <SettingsCheckboxRow
                            checked={reportUsage}
                            onChange={handleReportUsageChange}
                            label={"Send anonymous usage reports"}
                            info={"Helps us understand which app versions are actively used so we can prioritize improvements. Only app version, platform, and runtime are collected - no personal data or code."}
                            ariaLabel={"Send anonymous usage reports"}
                            settingsItem="appearance.usage-reports"
                        />
                    </SettingsSection>
                )}

            </div>
    );
};
