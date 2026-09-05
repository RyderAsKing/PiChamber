import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import {
    getDesktopProcessPerformanceRecording,
    isDesktopLocalOriginActive,
    isDesktopShell,
    isWebRuntime,
    setDesktopProcessPerformanceRecording,
    usesFramelessElectronChrome,
    type DesktopWindowControlsPosition,
    type DesktopWindowControlsStyle,
} from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { updateDesktopSettings } from '@/lib/persistence';
import { isPerfHudEnabled, setPerfHudEnabled, subscribePerfHudEnabled } from '@/lib/perf/perfFlags';
import { useConfigStore } from '@/stores/useConfigStore';
import { normalizeMobileKeyboardMode, supportsMobileKeyboardResizeContent } from '@/lib/mobileKeyboardMode';
import { getStoredMobileLayoutPreference, setStoredMobileLayoutPreference, type MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import {
    setDirectoryShowHidden,
    useDirectoryShowHidden,
} from '@/lib/directoryShowHidden';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { TerminalShellOption } from '@/lib/api/types';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

import {
  DEFAULT_PWA_INSTALL_NAME,
  MOBILE_KEYBOARD_MODE_OPTIONS,
  PWA_ORIENTATION_OPTIONS,
  TIME_FORMAT_OPTIONS,
  WEEK_START_OPTIONS,
  normalizePwaOrientation,
  type PwaInstallNameWindow,
  type VisibleSetting,
} from './visual/visualSettingsConstants';
import { ColorModeAndThemeSection } from './visual/ColorModeAndThemeSection';
import { DesktopWindowControlsSection } from './visual/DesktopWindowControlsSection';
import { LocalizationSection } from './visual/LocalizationSection';
import { AppInstallSection } from './visual/AppInstallSection';
import { DensityAndTypeSection } from './visual/DensityAndTypeSection';
import { NavigationSection } from './visual/NavigationSection';
import { ChatBehaviorSection } from './visual/ChatBehaviorSection';
import { DiagnosticsSection } from './visual/DiagnosticsSection';

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
    const collapseThinkingByDefault = useUIStore(state => state.collapseThinkingByDefault);
    const setCollapseThinkingByDefault = useUIStore(state => state.setCollapseThinkingByDefault);

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
    const draftStartersVisible = useUIStore(state => state.draftStartersVisible);
    const setDraftStartersVisible = useUIStore(state => state.setDraftStartersVisible);
    const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
    const setSettingsDefaultFileViewerPreview = useConfigStore((state) => state.setSettingsDefaultFileViewerPreview);
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
    const perfHudEnabled = React.useSyncExternalStore(subscribePerfHudEnabled, isPerfHudEnabled, () => false);
    const localDesktopDiagnostics = isDesktopShell() && isDesktopLocalOriginActive();
    const [processRecordingSupported, setProcessRecordingSupported] = React.useState(false);
    const [processRecordingEnabled, setProcessRecordingEnabled] = React.useState(false);
    const [processRecordingActive, setProcessRecordingActive] = React.useState(false);
    const [processRecordingSaving, setProcessRecordingSaving] = React.useState(false);
    const [processRecordingError, setProcessRecordingError] = React.useState<string | null>(null);

    const handleWindowControlsPositionChange = React.useCallback((value: DesktopWindowControlsPosition) => {
        setDesktopWindowControlsPosition(value);
        void updateDesktopSettings({ desktopWindowControlsPosition: value });
    }, [setDesktopWindowControlsPosition]);

    const handleWindowControlsStyleChange = React.useCallback((value: DesktopWindowControlsStyle) => {
        setDesktopWindowControlsStyle(value);
        void updateDesktopSettings({ desktopWindowControlsStyle: value });
    }, [setDesktopWindowControlsStyle]);

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

    const handleShowReasoningTracesChange = React.useCallback((enabled: boolean) => {
        setShowReasoningTraces(enabled);
        void updateDesktopSettings({ showReasoningTraces: enabled });
    }, [setShowReasoningTraces]);

    const handleCollapsibleThinkingBlocksChange = React.useCallback((enabled: boolean) => {
        setCollapsibleThinkingBlocks(enabled);
        void updateDesktopSettings({ collapsibleThinkingBlocks: enabled });
    }, [setCollapsibleThinkingBlocks]);

    const handleCollapseThinkingByDefaultChange = React.useCallback((enabled: boolean) => {
        setCollapseThinkingByDefault(enabled);
        void updateDesktopSettings({ collapseThinkingByDefault: enabled });
    }, [setCollapseThinkingByDefault]);

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

    const showDiagnostics = shouldShow('perfHud');

    React.useEffect(() => {
        if (!showDiagnostics || !localDesktopDiagnostics) {
            setProcessRecordingSupported(false);
            setProcessRecordingEnabled(false);
            setProcessRecordingActive(false);
            setProcessRecordingError(null);
            return;
        }

        let cancelled = false;
        void getDesktopProcessPerformanceRecording().then((status) => {
            if (cancelled) return;
            setProcessRecordingSupported(status?.supported === true);
            setProcessRecordingEnabled(status?.enabled === true);
            setProcessRecordingActive(status?.active === true);
            setProcessRecordingError(status?.enabled === true && status.active !== true
                ? 'Recording could not start. Disable it and try again.'
                : null);
        });
        return () => {
            cancelled = true;
        };
    }, [localDesktopDiagnostics, showDiagnostics]);

    React.useEffect(() => {
        if (!showDiagnostics || !localDesktopDiagnostics || !processRecordingEnabled) return;

        let cancelled = false;
        const timer = window.setInterval(() => {
            void getDesktopProcessPerformanceRecording().then((status) => {
                if (cancelled || !status?.supported) return;
                setProcessRecordingActive(status.active);
                if (!status.active) {
                    setProcessRecordingError('Recording stopped after a file write failure. Disable it and try again.');
                }
            });
        }, 10_000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [localDesktopDiagnostics, processRecordingEnabled, showDiagnostics]);

    const handleProcessRecordingEnabledChange = React.useCallback(async (enabled: boolean) => {
        if (!processRecordingSupported || processRecordingSaving) return;

        const previousEnabled = processRecordingEnabled;
        const previousActive = processRecordingActive;
        setProcessRecordingEnabled(enabled);
        setProcessRecordingSaving(true);
        setProcessRecordingError(null);
        try {
            const status = await setDesktopProcessPerformanceRecording(enabled);
            if (!status?.supported || status.enabled !== enabled || (enabled && !status.active)) {
                throw new Error('Failed to update process performance recording');
            }
            setProcessRecordingEnabled(status.enabled);
            setProcessRecordingActive(status.active);
        } catch {
            setProcessRecordingEnabled(previousEnabled);
            setProcessRecordingActive(previousActive);
            setProcessRecordingError('Failed to update process performance recording.');
        } finally {
            setProcessRecordingSaving(false);
        }
    }, [processRecordingActive, processRecordingEnabled, processRecordingSaving, processRecordingSupported]);

    const hasThemeSettings = shouldShow('theme');
    const showWindowControlsPositionSetting = shouldShow('windowControlsPosition') && showWindowControlsPosition;
    const hasLocalizationSettings = shouldShow('theme') || shouldShow('timeFormat') || shouldShow('weekStart');
    const showMobileLayoutSetting = isMobile && isWebRuntime() && !isDesktopShell();
    const hasAppearanceSettings = (shouldShow('theme') || showWindowControlsPositionSetting || showMobileLayoutSetting || shouldShow('pwaInstallName') || shouldShow('pwaOrientation') || shouldShow('timeFormat') || shouldShow('weekStart'));
    const hasLayoutSettings = shouldShow('fontSize') || shouldShow('terminalFontSize') || shouldShow('editorFontSize') || shouldShow('spacing') || (shouldShow('inputBarOffset') && isMobile);
    const hasNavigationSettings = shouldShow('terminalQuickKeys') || ((shouldShow('terminalShell') || shouldShow('terminalLoginShell'))) || shouldShow('fileEditorKeymap') || shouldShow('autoSaveEnabled') || shouldShow('expandedEditorToolbar');
    const hasBehaviorSettings = shouldShow('mermaidRendering')
        || shouldShow('userMessageRendering')
        || shouldShow('collapsibleUserMessages')
        || shouldShow('stickyUserHeader')
        || shouldShow('promptNavigatorEnabled')
        || shouldShow('wideChatLayout')
        || shouldShow('codeBlockLineWrap')
        || shouldShow('splitAssistantMessageActions')
        || shouldShow('diffLayout')
        || shouldShow('dotfiles')
        || shouldShow('fileViewerPreview')
        || shouldShow('reasoning')
        || shouldShow('followUpBehavior')
        || shouldShow('persistDraft')
        || shouldShow('showToolFileIcons')
        || shouldShow('expandedTools')
        || shouldShow('inputSpellcheck');
    const showBehaviorMessageOptions = shouldShow('userMessageRendering')
        || shouldShow('mermaidRendering')
        || shouldShow('diffLayout')
        || shouldShow('followUpBehavior');
    const showBehaviorFeatureCheckboxes = shouldShow('collapsibleUserMessages')
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
        || shouldShow('inputSpellcheck')
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
        <>

                {/* --- Appearance & Themes --- */}
                {hasAppearanceSettings && (
                    <>
                        {hasThemeSettings && (
                            <ColorModeAndThemeSection
                                themeMode={themeMode}
                                setThemeMode={setThemeMode}
                                showMobileLayoutSetting={showMobileLayoutSetting}
                                mobileLayoutPreference={mobileLayoutPreference}
                                onMobileLayoutPreferenceChange={handleMobileLayoutPreferenceChange}
                                selectedLightTheme={selectedLightTheme}
                                setLightThemePreference={setLightThemePreference}
                                lightThemes={lightThemes}
                                selectedDarkTheme={selectedDarkTheme}
                                setDarkThemePreference={setDarkThemePreference}
                                darkThemes={darkThemes}
                                formatThemeLabel={formatThemeLabel}
                                customThemesLoading={customThemesLoading}
                                themesReloading={themesReloading}
                                setThemesReloading={setThemesReloading}
                                reloadCustomThemes={reloadCustomThemes}
                                dockBadgeSupported={dockBadgeSupported}
                                dockBadgeEnabled={dockBadgeEnabled}
                                setDockBadgeEnabled={setDockBadgeEnabled}
                            />
                        )}

                        {showWindowControlsPositionSetting && (
                            <DesktopWindowControlsSection
                                desktopWindowControlsPosition={desktopWindowControlsPosition}
                                desktopWindowControlsStyle={desktopWindowControlsStyle}
                                hasThemeSettings={hasThemeSettings}
                                onWindowControlsPositionChange={handleWindowControlsPositionChange}
                                onWindowControlsStyleChange={handleWindowControlsStyleChange}
                            />
                        )}

                        {hasLocalizationSettings && (
                            <LocalizationSection
                                shouldShowTimeFormat={shouldShow('timeFormat')}
                                shouldShowWeekStart={shouldShow('weekStart')}
                                timeFormatPreference={timeFormatPreference}
                                selectedTimeFormatLabel={selectedTimeFormatLabel}
                                onTimeFormatPreferenceChange={handleTimeFormatPreferenceChange}
                                weekStartPreference={weekStartPreference}
                                selectedWeekStartLabel={selectedWeekStartLabel}
                                onWeekStartPreferenceChange={handleWeekStartPreferenceChange}
                            />
                        )}

                        {(showPwaInstallNameSetting || showPwaOrientationSetting || showMobileKeyboardModeSetting) && (
                            <AppInstallSection
                                showPwaInstallNameSetting={showPwaInstallNameSetting}
                                pwaInstallName={pwaInstallName}
                                setPwaInstallName={setPwaInstallName}
                                onApplyPwaInstallName={applyPwaInstallName}
                                showPwaOrientationSetting={showPwaOrientationSetting}
                                pwaOrientation={pwaOrientation}
                                selectedPwaOrientationLabel={selectedPwaOrientationLabel}
                                onApplyPwaOrientation={applyPwaOrientation}
                                showMobileKeyboardModeSetting={showMobileKeyboardModeSetting}
                                mobileKeyboardMode={mobileKeyboardMode}
                                selectedMobileKeyboardModeLabel={selectedMobileKeyboardModeLabel}
                                onSetMobileKeyboardMode={(mode) => {
                                    setMobileKeyboardMode(mode);
                                    void updateDesktopSettings({ mobileKeyboardMode: mode });
                                }}
                            />
                        )}
                    </>
                )}

                {/* --- Density & type --- */}
                {hasLayoutSettings && (
                    <DensityAndTypeSection
                        shouldShow={shouldShow}
                        uiFont={uiFont}
                        setUiFont={setUiFont}
                        monoFont={monoFont}
                        setMonoFont={setMonoFont}
                        fontSize={fontSize}
                        setFontSize={setFontSize}
                        terminalFontSize={terminalFontSize}
                        setTerminalFontSize={setTerminalFontSize}
                        editorFontSize={editorFontSize}
                        setEditorFontSize={setEditorFontSize}
                        padding={padding}
                        setPadding={setPadding}
                        inputBarOffset={inputBarOffset}
                        setInputBarOffset={setInputBarOffset}
                        isMobile={isMobile}
                    />
                )}

                {/* --- Navigation --- */}
                {hasNavigationSettings && (
                    <NavigationSection
                        shouldShow={shouldShow}
                        fileEditorKeymap={fileEditorKeymap}
                        setFileEditorKeymap={setFileEditorKeymap}
                        autoSaveEnabled={autoSaveEnabled}
                        setAutoSaveEnabled={setAutoSaveEnabled}
                        expandedEditorToolbar={expandedEditorToolbar}
                        onExpandedEditorToolbarChange={handleExpandedEditorToolbarChange}
                        showTerminalQuickKeysOnDesktop={showTerminalQuickKeysOnDesktop}
                        setShowTerminalQuickKeysOnDesktop={setShowTerminalQuickKeysOnDesktop}
                        showTerminalShellSetting={showTerminalShellSetting}
                        terminalShell={terminalShell}
                        setTerminalShell={setTerminalShell}
                        terminalShellOptions={terminalShellOptions}
                        terminalShellSupportsLogin={terminalShellSupportsLogin}
                        terminalLoginShellEnabled={terminalLoginShellEnabled}
                        setTerminalLoginShellEnabled={setTerminalLoginShellEnabled}
                    />
                )}

                <ChatBehaviorSection
                    hasBehaviorSettings={hasBehaviorSettings}
                    showBehaviorMessageOptions={showBehaviorMessageOptions}
                    behaviorSectionDivider={behaviorSectionDivider}
                    showBehaviorFeatureCheckboxes={showBehaviorFeatureCheckboxes}
                    shouldShow={shouldShow}
                    userMessageRenderingMode={userMessageRenderingMode}
                    onUserMessageRenderingModeChange={handleUserMessageRenderingModeChange}
                    mermaidRenderingMode={mermaidRenderingMode}
                    onMermaidRenderingModeChange={handleMermaidRenderingModeChange}
                    diffLayoutPreference={diffLayoutPreference}
                    setDiffLayoutPreference={setDiffLayoutPreference}
                    followUpBehavior={followUpBehavior}
                    setFollowUpBehavior={setFollowUpBehavior}
                    showExpandedBashTools={showExpandedBashTools}
                    onShowExpandedBashToolsChange={handleShowExpandedBashToolsChange}
                    showExpandedEditTools={showExpandedEditTools}
                    onShowExpandedEditToolsChange={handleShowExpandedEditToolsChange}
                    draftStartersVisible={draftStartersVisible}
                    onDraftStartersVisibleChange={handleDraftStartersVisibleChange}
                    showReasoningTraces={showReasoningTraces}
                    onShowReasoningTracesChange={handleShowReasoningTracesChange}
                    collapsibleThinkingBlocks={collapsibleThinkingBlocks}
                    onCollapsibleThinkingBlocksChange={handleCollapsibleThinkingBlocksChange}
                    collapseThinkingByDefault={collapseThinkingByDefault}
                    onCollapseThinkingByDefaultChange={handleCollapseThinkingByDefaultChange}
                    collapsibleUserMessages={collapsibleUserMessages}
                    onCollapsibleUserMessagesChange={handleCollapsibleUserMessagesChange}
                    stickyUserHeader={stickyUserHeader}
                    onStickyUserHeaderChange={handleStickyUserHeaderChange}
                    promptNavigatorEnabled={promptNavigatorEnabled}
                    onPromptNavigatorEnabledChange={handlePromptNavigatorEnabledChange}
                    wideChatLayoutEnabled={wideChatLayoutEnabled}
                    onWideChatLayoutChange={handleWideChatLayoutChange}
                    showSplitAssistantMessageActions={showSplitAssistantMessageActions}
                    onShowSplitAssistantMessageActionsChange={handleShowSplitAssistantMessageActionsChange}
                    codeBlockLineWrap={codeBlockLineWrap}
                    setCodeBlockLineWrap={setCodeBlockLineWrap}
                    showToolFileIcons={showToolFileIcons}
                    onShowToolFileIconsChange={handleShowToolFileIconsChange}
                    showTurnChangedFiles={showTurnChangedFiles}
                    onShowTurnChangedFilesChange={handleShowTurnChangedFilesChange}
                    directoryShowHidden={directoryShowHidden}
                    setDirectoryShowHidden={setDirectoryShowHidden}
                    settingsDefaultFileViewerPreview={settingsDefaultFileViewerPreview}
                    onFileViewerPreviewChange={handleFileViewerPreviewChange}
                    persistChatDraft={persistChatDraft}
                    setPersistChatDraft={setPersistChatDraft}
                    inputSpellcheckEnabled={inputSpellcheckEnabled}
                    onInputSpellcheckChange={handleInputSpellcheckChange}
                />

                {shouldShow('perfHud') && (
                    <DiagnosticsSection
                        perfHudEnabled={perfHudEnabled}
                        onPerfHudEnabledChange={setPerfHudEnabled}
                        processRecordingSupported={processRecordingSupported}
                        processRecordingEnabled={processRecordingEnabled}
                        processRecordingActive={processRecordingActive}
                        processRecordingSaving={processRecordingSaving}
                        processRecordingError={processRecordingError}
                        onProcessRecordingEnabledChange={handleProcessRecordingEnabledChange}
                    />
                )}

        </>
    );
};
