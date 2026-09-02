/* eslint-disable */
import React from 'react';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useSelectionStore } from '@/sync/selection-store';
import { serializeAttachmentsForQueue, useInputStore } from '@/sync/input-store';
import {
    ATTACHMENT_ACCEPT,
    getUnsupportedAttachmentInputs,
    type AttachmentInputModality,
} from '@/sync/attachment-files';
import { areAttachmentsReadyToSend, hasFailedAttachmentUploads, hasPendingAttachmentUploads, type AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
import { useUserMessageHistory } from "@/sync/sync-context";
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
    createChatDraftIdentity,
    readChatDraft,
    writeChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
} from '@/lib/chatDraftPersistence';
import { AttachedFilesList } from './FileAttachment';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { ToolPopupContent } from './message/types';
import { QueuedMessageChips } from './QueuedMessageChips';
import type { FileMentionHandle } from './FileMentionAutocomplete';
import type { CommandAutocompleteHandle, CommandInfo } from './CommandAutocomplete';
import type { SkillAutocompleteHandle } from './SkillAutocomplete';
import type { SnippetAutocompleteHandle } from './SnippetAutocomplete';
import { cn } from "@/lib/utils";
import { ModelControls } from './ModelControls';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { StatusRow } from './StatusRow';
import { PendingChangesBar } from './PendingChangesBar';
import { useChatSurfaceMode } from './chatSurfaceContext';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
import { useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import type { MobileControlsPanel } from './mobileControlsUtils';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { Icon } from "@/components/icon/Icon";
import { Button } from "@/components/ui/button";
import { DraftPresetChips } from './DraftPresetChips';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { invalidateSkillsLoadCache, useSkillsStore } from '@/stores/useSkillsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { extractGitChangedFiles } from './changedFiles';
import { sessionEvents } from '@/lib/sessionEvents';
import { fetchResponseStyleInstruction } from '@/lib/responseStyle';
import { wrapSystemReminder } from '@/lib/systemReminder';
import { getSyncMessages } from '@/sync/sync-refs';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { getFileMentionInputSourceForInsertedText, type FileMentionAutocompleteInputSource } from './fileMentionAutocompleteState';
import {
    classifyMention,
    scanMentions,
} from './composer/language/mentions';
import { resolveAutocompleteTrigger, type AutocompleteKind } from './composer/language/triggers';
import { type ComposerLanguageContext } from './composer/language/tokenize';
import {
    ComposerEditor,
    type ComposerChange,
    type ComposerEditorHandle,
} from './composer/editor/ComposerEditor';
import { createComposerEditorViewStore } from './composer/editor/viewStore';
import {
    appendInlineText,
    appendWithLineBreaks,
    withInlineInsertionBoundaries,
} from './composer/text';
import { useComposerDrop } from './composer/attachments/useComposerDrop';
import { useComposerPaste } from './composer/attachments/useComposerPaste';
import {
    normalizePath,
    toProjectRelativeMentionPath,
    toServerFileUrl,
} from './composer/attachments/filePaths';
import { buildOutgoingMessage, buildSkillMentionInstruction, collectInlineSkillMentions } from './composer/submit/buildOutgoingMessage';
import { parseSlashCommand, tryExecuteLocalSlashCommand } from './composer/submit/slashCommands';
import { useAutocompletePosition } from './composer/state/useAutocompletePosition';
import { useMessageHistory } from './composer/state/useMessageHistory';
import { useComposerDraft } from './composer/state/useComposerDraft';
import { useComposerAutocompleteHandlers } from './composer/state/useComposerAutocompleteHandlers';
import { useComposerKeyNavigation } from './composer/state/useComposerKeyNavigation';
import { useDraftTarget } from './composer/state/useDraftTarget';
import { useDraftBranchCheckout } from './composer/state/useDraftBranchCheckout';
import { useDraftWorktreeCreation } from './composer/state/useDraftWorktreeCreation';
import { useMobileComposerShell } from './composer/state/useMobileComposerShell';
import { useMobileViewportPin } from './composer/state/useMobileViewportPin';
import {
    DraftTargetSelectors,
    MobileDraftTargetSheets,
    MobileDraftTargetTriggers,
} from './composer/ui/DraftTargetSelectors';
import { DraftBranchCheckoutDialog } from './composer/ui/DraftBranchCheckoutDialog';
import { ComposerAutocompletePopups } from './composer/ui/ComposerAutocompletePopups';
import { ComposerFooter } from './composer/ui/ComposerFooter';
import { RevertedMessageDock } from './composer/ui/RevertedMessageDock';
import { ComposerVoiceButton } from './composer/ui/ComposerVoiceButton';
import { ComposerVoiceActions, ComposerVoiceInput } from './composer/ui/ComposerVoiceInput';
import { AgentThinkingLoader } from './AgentThinkingLoader';
import { useComposerDictation } from '@/lib/dictation/use-composer-dictation';

// Lazy like in ChatMessage: a static import would pull the @pierre/diffs and
// Shiki stacks into the eager startup graph for a dialog opened on demand.
const ToolOutputDialog = lazyWithChunkRecovery(() => import('./message/ToolOutputDialog'));

const MAX_VISIBLE_COMPOSER_LINES = 5;
/**
 * Mobile grows the composer with content instead of offering a fullscreen
 * gesture — the old swipe-up handle bought barely a line of extra height.
 * The real ceiling is measured: the editor may grow until the composer fills
 * its screen container (marked data-composer-bound in ChatContainer), with
 * the chrome around the editor read from the DOM. The line cap only stops
 * absurdly tall editors on tablets.
 */
const MAX_MOBILE_COMPOSER_LINES = 16;
/**
 * Breathing room between the fully grown composer and the top of its screen
 * container: without it the composer's border lands exactly on the header's
 * bottom edge on the chat screen. A visual gap by design, not an estimate.
 */
const MOBILE_COMPOSER_BOUND_GAP_PX = 4;
const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_SENDING_IDS: string[] = [];
const COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH = 560;

type SubmitOptions = {
    queuedOnly?: boolean;
    queuedMessageId?: string;
    delivery?: 'steer';
    /** Submit this text instead of the composer input. */
    presetText?: string;
};

const hasUserMessages = (sessionId: string, directory?: string) => {
    return getSyncMessages(sessionId, directory).some((message) => message.role === 'user');
};

const MemoModelControls = React.memo(ModelControls);
const MemoStatusRow = React.memo(StatusRow);

interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
}

const resolveChatDraftIdentity = (sessionId: string | null): ChatDraftIdentity | null => {
    const sessionState = useSessionUIStore.getState();
    const newSessionDirectory = sessionState.newSessionDraft?.open
        ? sessionState.newSessionDraft.directoryOverride
        : null;
    const directory = sessionId
        ? sessionState.getDirectoryForSession(sessionId) ?? sessionState.currentSessionDirectory
        : newSessionDirectory ?? useDirectoryStore.getState().currentDirectory;
    return createChatDraftIdentity(getRuntimeKey(), directory, sessionId);
};

const ChatInputComponent: React.FC<ChatInputProps> = ({ onOpenSettings, scrollToBottom }) => {
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);
    const initialDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(null);
    const initialDraftSnapshotRef = React.useRef<ChatDraftSnapshot>({ text: '', confirmedMentions: new Set() });
    const [message, setMessage] = React.useState(() => {
        const sessionId = useSessionUIStore.getState().currentSessionId;
        const identity = resolveChatDraftIdentity(sessionId);
        const snapshot = readChatDraft(identity);
        initialDraftIdentityRef.current = identity;
        initialDraftSnapshotRef.current = snapshot;
        if (snapshot.text) {
            initialDraftRef.current = snapshot.text;
        }
        return snapshot.text;
    });
    const confirmedMentionsRef = React.useRef<Set<string>>(initialDraftSnapshotRef.current.confirmedMentions);
    const [inputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    // At most one picker is open at a time; the prompt language decides which.
    const [openAutocomplete, setOpenAutocomplete] = React.useState<AutocompleteKind | null>(null);
    const [autocompleteQuery, setAutocompleteQuery] = React.useState('');
    const closeAutocomplete = React.useCallback(() => setOpenAutocomplete(null), []);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);
    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);
    const [mobileDraftPickerQuery, setMobileDraftPickerQuery] = React.useState('');
    // Message history navigation state (up/down arrow to recall previous messages)
    const composerRef = React.useRef<ComposerEditorHandle>(null);
    // Keep the CodeMirror view store stable for the lifetime of the composer.
    const composerViewStore = React.useRef(createComposerEditorViewStore()).current;
    React.useEffect(() => () => {
        composerViewStore.view?.destroy();
        composerViewStore.view = null;
    }, [composerViewStore]);
    const composerFormRef = React.useRef<HTMLFormElement | null>(null);
    const cursorPosRef = React.useRef(0);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const suppressNextFileMentionPasteRef = React.useRef(false);
    const suppressNextFileMentionPasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const canAcceptDropRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);
    const currentChatDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraftIdentityRef.current);

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    const sendMessage = React.useRef((...args: unknown[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const extensionEditor = usePiSessionSnapshot(
        (state) => currentSessionId ? state.reducer.bySession.get(currentSessionId)?.extensionEditor : undefined,
        (previous, next) => previous?.sequence === next?.sequence,
        currentSessionId ? `session:${currentSessionId}` : 'chrome',
    );
    const appliedExtensionEditorBySessionRef = React.useRef(new Map<string, number>());
    React.useEffect(() => {
        if (!currentSessionId || !extensionEditor) return;
        const previousSequence = appliedExtensionEditorBySessionRef.current.get(currentSessionId) ?? -1;
        if (extensionEditor.sequence <= previousSequence) return;
        appliedExtensionEditorBySessionRef.current.set(currentSessionId, extensionEditor.sequence);
        confirmedMentionsRef.current.clear();
        setMessage(extensionEditor.text);
        closeAutocomplete();
        getPiSessionStore().consumeExtensionEditor(currentSessionId, extensionEditor.sequence);
    }, [closeAutocomplete, currentSessionId, extensionEditor]);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const currentDirectory = useEffectiveDirectory() ?? fallbackDirectory;
    const currentSessionDirectoryForSync = useSessionUIStore(
        React.useCallback((s) => currentSessionId ? s.getDirectoryForSession(currentSessionId) : null, [currentSessionId]),
    );
    const activeRuntimeKey = getRuntimeKey();

    // Keep the skill catalog warm for the active runtime/directory. The store
    // is not persisted and previously only filled on demand (autocomplete open
    // or draft mount). On mobile the LAN/relay round-trip can still be in
    // flight when the user hits send, so the synthetic "use the skill tool"
    // hint was empty and the model ignored the slash invocation.
    React.useEffect(() => {
        invalidateSkillsLoadCache();
        void useSkillsStore.getState().loadSkills();
        // Runtime switches (mobile LAN ↔ relay) do not remount ChatInput, so
        // also subscribe explicitly to endpoint changes.
        const unsubscribe = subscribeRuntimeEndpointChanged(() => {
            invalidateSkillsLoadCache();
            void useSkillsStore.getState().loadSkills();
        });
        return unsubscribe;
    }, [currentDirectory]);

    const chatDraftIdentity = React.useMemo(
        () => createChatDraftIdentity(
            activeRuntimeKey,
            currentSessionDirectoryForSync ?? currentDirectory,
            currentSessionId,
        ),
        [activeRuntimeKey, currentDirectory, currentSessionDirectoryForSync, currentSessionId],
    );
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const newSessionDraftOpen = Boolean(newSessionDraft?.open);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);
    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
    const attachedFiles = useInputStore((s) => s.attachedFiles);
    const addAttachedFile = useInputStore((s) => s.addAttachedFile);
    const detachAttachedFiles = useInputStore((s) => s.detachAttachedFiles);
    const consumePendingInputText = useInputStore((s) => s.consumePendingInputText);
    const pendingPresetSubmit = useInputStore((s) => s.pendingPresetSubmit);
    const pendingInputText = useInputStore((s) => s.pendingInputText);
    const pendingRevertText = useInputStore((s) => s.pendingRevertText);
    const consumePendingRevertText = useInputStore((s) => s.consumePendingRevertText);
    const consumePendingSyntheticParts = useInputStore((s) => s.consumePendingSyntheticParts);
    const acknowledgeSessionAbort = useSessionUIStore((s) => s.acknowledgeSessionAbort);
    const abortCurrentOperation = React.useCallback(
        (sessionIdOverride?: string) => sessionActions.abortCurrentOperation(sessionIdOverride ?? currentSessionId ?? ''),
        [currentSessionId],
    );
    const currentManagementSessionId = currentSessionId;

    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    // Subscribe to both sources read by getModelMetadata so async metadata and provider updates are observed.
    useConfigStore((state) => state.modelsMetadata);
    useConfigStore((state) => state.providers);
    const currentModelMetadata = currentProviderId && currentModelId
        ? getModelMetadata(currentProviderId, currentModelId)
        : undefined;
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const agents = getVisibleAgents();
    const isMobile = useUIStore((state) => state.isMobile);
    const dictation = useComposerDictation();
    const dictationSelectionRef = React.useRef({ start: 0, end: 0 });
    const dictationErrorRef = React.useRef<string | null>(null);
    const dictationActive = dictation.state === 'requesting-permission'
        || dictation.state === 'recording'
        || dictation.state === 'reconnecting'
        || dictation.state === 'transcribing';
    const chatSurfaceMode = useChatSurfaceMode();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';
    const hasHardwareKeyboard = useHardwareKeyboard();
    const { enabled: isTabletLayout } = useTabletLayout();
    const isMobileForDraft = isMobile && !isTabletLayout;
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const setExpandedInput = useUIStore((state) => state.setExpandedInput);
    const setTimelineDialogOpen = useUIStore((state) => state.setTimelineDialogOpen);
    const { git: runtimeGit } = useRuntimeAPIs();
    const { currentTheme } = useThemeSystem();
    const chatSearchDirectory = useChatSearchDirectory();
    const isGitRepo = useIsGitRepo(currentDirectory);
    const currentGitStatus = useGitStore((state) =>
        currentDirectory ? state.directories.get(currentDirectory)?.status ?? null : null,
    );
    const ensureGitStatus = useGitStore((state) => state.ensureStatus);
    const fetchGitStatus = useGitStore((state) => state.fetchStatus);
    const clearGitDiffCache = useGitStore((state) => state.clearDiffCache);
    const [showAbortStatus, setShowAbortStatus] = React.useState(false);
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});
    const draftBranchCheckout = useDraftBranchCheckout<SubmitOptions | undefined>({
        activeRuntimeKey,
        intent: newSessionDraft?.branchIntent,
        onReady: (continuation) => {
            void handleSubmitRef.current(continuation);
        },
    });
    const draftWorktreeCreation = useDraftWorktreeCreation({
        intent: newSessionDraft?.worktreeIntent,
    });
    const [isNarrowComposer, setIsNarrowComposer] = React.useState(false);
    const [attachmentPreview, setAttachmentPreview] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });
    // Mount the lazy preview dialog only after its first open; rendering it
    // closed would fetch the ToolOutputDialog chunk (with the @pierre/diffs
    // stack) on the draft screen before any preview is requested.
    const [attachmentPreviewMounted, setAttachmentPreviewMounted] = React.useState(false);
    React.useEffect(() => {
        if (attachmentPreview.open) {
            setAttachmentPreviewMounted(true);
        }
    }, [attachmentPreview.open]);
    const attachmentCompatibilityRef = React.useRef({
        modelKey: `${currentProviderId ?? ''}/${currentModelId ?? ''}`,
        modalitySignature: currentModelMetadata?.modalities?.input?.slice().sort().join(',') ?? null,
        attachmentIds: new Set<string>(),
    });

    React.useEffect(() => {
        const modelKey = `${currentProviderId ?? ''}/${currentModelId ?? ''}`;
        const inputModalities = currentModelMetadata?.modalities?.input;
        const modalitySignature = inputModalities?.slice().sort().join(',') ?? null;
        const previous = attachmentCompatibilityRef.current;
        const modelChanged = previous.modelKey !== modelKey;
        const metadataBecameAvailable = previous.modalitySignature === null && modalitySignature !== null;
        const filesToCheck = modelChanged || metadataBecameAvailable
            ? attachedFiles
            : attachedFiles.filter((file) => !previous.attachmentIds.has(file.id));

        attachmentCompatibilityRef.current = {
            modelKey,
            modalitySignature,
            attachmentIds: new Set(attachedFiles.map((file) => file.id)),
        };

        if (!inputModalities || filesToCheck.length === 0) return;

        const incompatibleFiles = getUnsupportedAttachmentInputs(filesToCheck, inputModalities);
        if (incompatibleFiles.length === 0) return;

        const unsupportedModalities = Array.from(new Set(incompatibleFiles.map(({ modality }) => modality)));
        const modalityLabels: Record<AttachmentInputModality, string> = {
            text: "Text",
            image: "Image",
            pdf: "PDF",
            audio: "Audio",
            video: "Video",
        };
        const filenames = incompatibleFiles.map(({ attachment }) => attachment.filename);
        const fileSummary = filenames.length > 3
            ? `${filenames.slice(0, 3).join(', ')} (+${filenames.length - 3})`
            : filenames.join(', ');

        toast.warning(`${currentModelMetadata.name ?? currentModelId ?? ''} does not support ${unsupportedModalities.map((modality) => modalityLabels[modality]).join(', ')} input required by ${fileSummary}. You can still send the message, but these attachments may be ignored.`, { id: `attachment-modalities:${modelKey}` });
    }, [attachedFiles, currentModelId, currentModelMetadata, currentProviderId]);

    const handleShowAttachmentPreview = React.useCallback((content: ToolPopupContent) => {
        if (!content.image) return;
        setAttachmentPreview(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);

    const handleAttachmentPreviewOpenChange = React.useCallback((open: boolean) => {
        setAttachmentPreview((prev) => ({ ...prev, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        void ensureGitStatus(currentDirectory, runtimeGit);
    }, [currentDirectory, runtimeGit, ensureGitStatus]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) return;
            if (hint.paths?.length) {
                clearGitDiffCache(currentDirectory, hint.paths);
            }
            void fetchGitStatus(currentDirectory, runtimeGit, { silent: true });
        });
    }, [clearGitDiffCache, currentDirectory, runtimeGit, fetchGitStatus]);

    const isDesktopExpanded = false;
    // Mobile fullscreen composer (entered via the drag handle's swipe-up).
    const isMobileExpanded = isExpandedInput && isMobile;
    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;
    const [composerVisualLines, setComposerVisualLines] = React.useState(1);
    const isDesktopStackedComposer = Boolean(!isMobile && !isMiniChatSurface);
    const isNewSessionStackedComposer = Boolean(newSessionDraftOpen && isDesktopStackedComposer && !isComposerExpanded);
    const isInlineComposer = !isMobile && !isComposerExpanded && !isDesktopStackedComposer;
    const chatInputRadius = isMobile || isDesktopStackedComposer
        ? '1.5rem'
        : '9999px';
    const useCompactChatPlaceholder = isMobile || isNarrowComposer;

    React.useEffect(() => {
        const element = dropZoneRef.current;
        if (!element) return;

        const updateWidth = (width: number) => {
            const next = width > 0 && width < COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH;
            setIsNarrowComposer((prev) => (prev === next ? prev : next));
        };

        updateWidth(element.clientWidth);

        if (typeof ResizeObserver === 'undefined') {
            const handleResize = () => updateWidth(element.clientWidth);
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
        }

        const observer = new ResizeObserver((entries) => {
            updateWidth(entries[0]?.contentRect.width ?? element.clientWidth);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const knownAgentNames = React.useMemo(
        () => new Set(agents.flatMap((agent) => agent.name ? [agent.name.toLowerCase()] : [])),
        [agents]
    );
    const knownAgentNamesRef = React.useRef(knownAgentNames);
    knownAgentNamesRef.current = knownAgentNames;

    // Known slash-invocations (skills + built-ins) used to highlight
    // matching /tokens in the composer, the same way confirmed @files are.
    const availableSkills = useSkillsStore((s) => s.skills);
    const knownSlashNames = React.useMemo(() => {
        const names = new Set<string>([
            'init', 'review', 'undo', 'redo', 'timeline', 'compact', 'summary', 'plan-feature', 'catch-up', 'debug', 'weigh', 'explore',
        ]);
        for (const skill of availableSkills) names.add(skill.name.toLowerCase());
        return names;
    }, [availableSkills]);

    const availableSnippets = useSnippetsStore((s) => s.snippets);
    const knownSnippetTriggers = React.useMemo(() => {
        const triggers = new Set<string>();
        for (const snippet of availableSnippets) {
            triggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
        }
        return triggers;
    }, [availableSnippets]);

    const attachmentFilenames = React.useMemo(
        () => attachedFiles.map((file) => file.filename),
        [attachedFiles],
    );

    /**
     * Everything the prompt language needs to resolve references. Rebuilt only
     * when a registry changes, so typing does not churn the tokenizer input.
     */
    const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
        inputMode,
        knownAgentNames,
        confirmedMentions: confirmedMentionsRef.current,
        knownSlashNames,
        knownSnippetTriggers,
        attachmentFilenames,
    }), [attachmentFilenames, inputMode, knownAgentNames, knownSlashNames, knownSnippetTriggers]);

    const sanitizeAttachmentsForSend = React.useCallback(
        (files: readonly AttachedFile[] | undefined): AttachedFile[] => [...(files ?? [])]
            .map((file) => ({
                ...file,
                dataUrl: file.source === 'server' && file.serverPath
                    ? toServerFileUrl(file.serverPath)
                    : file.dataUrl,
            })),
        [],
    );

    const extractInlineFileMentions = React.useCallback((rawText: string): { sanitizedText: string; attachments: AttachedFile[] } => {
        return {
            sanitizedText: rawText,
            attachments: [],
        };
    }, []);
    const abortTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevWasAbortedRef = React.useRef(false);

    // Message queue
    const messageQueueTarget = currentSessionId
        ? createMessageQueueTarget(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory)
        : null;
    const messageQueueKey = messageQueueTarget ? getMessageQueueKey(messageQueueTarget) : null;
    const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!messageQueueKey) return EMPTY_QUEUE;
                return state.queuedMessages[messageQueueKey] ?? EMPTY_QUEUE;
            },
            [messageQueueKey]
        )
    );
    const addToQueue = useMessageQueueStore((state) => state.addToQueue);
    const clearQueue = useMessageQueueStore((state) => state.clearQueue);
    const removeFromQueue = useMessageQueueStore((state) => state.removeFromQueue);

    // User message history for up/down arrow navigation.
    // Keep this on a narrow hook instead of full session message records.
    const messageHistory = useMessageHistory(useUserMessageHistory(currentSessionId ?? ""));

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    React.useEffect(() => {
        currentChatDraftIdentityRef.current = chatDraftIdentity;
    }, [chatDraftIdentity]);

    // Draft persistence: identity switching, debounced writes and the
    // flush-on-hide edges live in the hook.
    const { persistNow: persistDraftImmediately } = useComposerDraft({
        message,
        messageRef,
        setMessage,
        confirmedMentionsRef,
        identity: chatDraftIdentity,
        persistEnabled: persistChatDraft,
        initialDraft: {
            text: initialDraftRef.current ?? '',
            identity: initialDraftIdentityRef.current,
        },
        onIdentityChange: () => setInputMode('normal'),
        onDraftRestored: () => composerRef.current?.selectAll(),
    });

    // Focus textarea when new session draft is opened
    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);
    React.useEffect(() => {
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen) {
            // New session draft just opened - focus the textarea
            requestAnimationFrame(() => {
                if (isMobile) {
                    // On mobile, use preventScroll to avoid viewport jumping
                    composerRef.current?.focus({ preventScroll: true });
                } else {
                    composerRef.current?.focus();
                }
            });
        }
        prevNewSessionDraftOpenRef.current = newSessionDraftOpen;
    }, [newSessionDraftOpen, isMobile]);

    // Session activity for queue availability and controls
    const { phase: sessionPhase } = useCurrentSessionActivity();


    // Consume pending input text (e.g., from revert action)
    React.useEffect(() => {
        if (pendingInputText !== null) {
            const pending = consumePendingInputText();
            if (pending?.text) {
                if (pending.mode === 'append') {
                    setMessage((prev) => {
                        const next = pending.text;
                        if (!next.trim()) return prev;
                        return appendWithLineBreaks(prev, next);
                    });
                } else if (pending.mode === 'append-inline') {
                    setMessage((prev) => appendInlineText(prev, pending.text));
                } else {
                    setMessage(pending.text);
                }
                // Focus textarea after setting message
                setTimeout(() => {
                    composerRef.current?.focus();
                }, 0);
            }
        }
    }, [pendingInputText, consumePendingInputText]);

    // Consume pending revert text — only when composer is empty.
    React.useEffect(() => {
        if (pendingRevertText !== null) {
            const text = consumePendingRevertText();
            if (text && message.trim().length === 0) {
                setMessage(text);
                setTimeout(() => {
                    composerRef.current?.focus();
                }, 0);
            }
        }
    }, [pendingRevertText, consumePendingRevertText, message]);

    const hasContent = message.trim().length > 0 || attachedFiles.length > 0;
    const hasQueuedMessages = queuedMessages.length > 0;
    const hasUsableModel = Boolean(currentProviderId && currentModelId);
    const attachmentsReady = areAttachmentsReadyToSend(attachedFiles);
    const attachmentGateMessage = hasPendingAttachmentUploads(attachedFiles)
        ? "Uploading attachments…"
        : hasFailedAttachmentUploads(attachedFiles) || (attachedFiles.length > 0 && !attachmentsReady)
            ? "Retry or remove failed attachments"
            : null;
    const canSend = (hasContent || hasQueuedMessages) && hasUsableModel && attachmentsReady;

    const canAbort = sessionPhase !== 'idle';

    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? message;
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0,
        };
    }, [attachedFiles.length, message]);

    // Add message to queue instead of sending
    const queueInFlightRef = React.useRef(false);
    const handleQueueMessage = React.useCallback(async () => {
        const inputSnapshot = getCurrentInputSnapshot();
        if (queueInFlightRef.current || !inputSnapshot.hasContent || !currentSessionId || !messageQueueTarget || !areAttachmentsReadyToSend(attachedFiles)) return;

        queueInFlightRef.current = true;
        let attachmentsToQueue: AttachedFile[];
        try {
            attachmentsToQueue = await serializeAttachmentsForQueue(sanitizeAttachmentsForSend(attachedFiles));
        } catch {
            toast.error("Attachment data could not be saved for the queue.");
            queueInFlightRef.current = false;
            return;
        }

        const messageToQueue = inputSnapshot.message.replace(/^\n+|\n+$/g, '');

        addToQueue(messageQueueTarget, {
            content: messageToQueue,
            attachments: attachmentsToQueue.length > 0 ? attachmentsToQueue : undefined,
            sendConfig: currentProviderId && currentModelId ? {
                providerID: currentProviderId,
                modelID: currentModelId,
                agent: currentAgentName ?? undefined,
                variant: currentVariant ?? undefined,
            } : undefined,
        });

        // Clear input and attachments
        // Note: confirmedMentionsRef is NOT cleared here because queued messages
        // are processed later in handleSubmit which reads the ref via extractInlineFileMentions.
        // The ref is cleared in handleSubmit after all queued messages are sent.
        if ((composerRef.current?.getValue() ?? messageRef.current) === inputSnapshot.message) setMessage('');
        if (attachmentsToQueue.length > 0) {
            detachAttachedFiles(attachmentsToQueue.map((attachment) => attachment.id));
        }

        queueInFlightRef.current = false;
        if (!isMobile) {
            composerRef.current?.focus();
        }
    }, [getCurrentInputSnapshot, currentSessionId, messageQueueTarget, attachedFiles, sanitizeAttachmentsForSend, addToQueue, detachAttachedFiles, isMobile, currentProviderId, currentModelId, currentAgentName, currentVariant]);

    const handleQueuedMessageEdit = React.useCallback((content: string) => {
        setMessage(content);
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, []);

    const handleQueuedMessageSend = React.useCallback((messageId: string) => {
        // Force-sending from the queue during a busy session counts as steer
        void handleSubmitRef.current({ queuedOnly: true, queuedMessageId: messageId, delivery: 'steer' });
    }, []);

    const getSubmitErrorMessage = (error: unknown, fallback: string) => {
        const message = error instanceof Error ? error.message : '';
        return message.toLowerCase().includes('runtime changed')
            ? "Message failed to send. Attachments restored."
            : message || fallback;
    };

    const handleSubmit = async (options?: SubmitOptions) => {
        const queuedOnly = options?.queuedOnly ?? false;
        const queuedMessageId = options?.queuedMessageId;
        const delivery = options?.delivery === 'steer' && sessionPhase !== 'idle' ? 'steer' : undefined;
        const capturedTarget = messageQueueTarget;
        if (!areAttachmentsReadyToSend(attachedFiles)) {
            if (hasPendingAttachmentUploads(attachedFiles)) toast.info("Uploading attachments…");
            else toast.error("Retry or remove failed attachments");
            return;
        }
        const inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || attachedFiles.length > 0,
            }
            : getCurrentInputSnapshot();
        // A queued item stays in the queue until its own send resolves, so the
        // auto-send hook may already be delivering one of these. Merging it here
        // would send the same message twice (the window is seconds over a relay).
        const sendingIds = messageQueueTarget
            ? useMessageQueueStore.getState().sendingIds[getMessageQueueKey(messageQueueTarget)] ?? EMPTY_SENDING_IDS
            : EMPTY_SENDING_IDS;
        const queuedMessagesToSend = (queuedMessageId
            ? queuedMessages.filter((message) => message.id === queuedMessageId)
            : queuedMessages
        ).filter((message) => !sendingIds.includes(message.id));

        if (queuedOnly) {
            if (queuedMessagesToSend.length === 0 || !currentSessionId) return;
        } else if ((!inputSnapshot.hasContent && !hasQueuedMessages) || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        const capturedSendConfig = queuedOnly ? queuedMessagesToSend[0]?.sendConfig : undefined;
        const providerIdToSend = capturedSendConfig?.providerID ?? currentProviderId;
        const modelIdToSend = capturedSendConfig?.modelID ?? currentModelId;
        const agentNameToSend = capturedSendConfig?.agent ?? currentAgentName;
        const variantToSend = capturedSendConfig?.variant ?? currentVariant;

        if (!providerIdToSend || !modelIdToSend) {
            console.warn('Cannot send message: provider or model not selected');
            toast.error("Select a provider and model before sending a message.");
            return;
        }

        const draftAtSend = useSessionUIStore.getState().newSessionDraft;
        const draftCommand = inputMode === 'normal' ? parseSlashCommand(inputSnapshot.message) : null;
        const commandStopsBeforeMaterialization = draftCommand?.name === 'compact';
        const worktreeIntent = !capturedTarget
            && !options?.queuedOnly
            && !options?.queuedMessageId
            && draftAtSend?.open
            && !commandStopsBeforeMaterialization
                ? draftAtSend.worktreeIntent
                : null;
        let worktreeCreationReceipt = draftWorktreeCreation.getReceipt(worktreeIntent);
        if (worktreeIntent && !worktreeCreationReceipt) {
            worktreeCreationReceipt = await draftWorktreeCreation.request({
                intent: worktreeIntent,
                prompt: inputSnapshot.message,
            });
            if (!worktreeCreationReceipt) return;
        }

        const branchIntent = !capturedTarget
            && !options?.queuedOnly
            && !options?.queuedMessageId
            && draftAtSend?.open
            && !commandStopsBeforeMaterialization
                ? draftAtSend.branchIntent
                : null;
        if (branchIntent && !draftBranchCheckout.getReceipt(branchIntent)) {
            if (draftBranchCheckout.dialogState) return;
            await draftBranchCheckout.request({
                intent: branchIntent,
                projectId: draftAtSend.selectedProjectId,
                continuation: options,
            });
            return;
        }

        if (currentSessionId && !queuedOnly) {
            // Sending is authoritative for blocking prompts: deny pending
            // permissions and dismiss open questions for the session subtree,
            // then queue the message once if either was open. The deny/clear
            // vanishes the card instantly (optimistic); rejecting unblocks the
            // agent's tool but does NOT end its turn, so a direct send would
            // race with the still-active run and be silently discarded by the
            // Pi session runner. Instead we queue; the queued-message auto-send
            // hook delivers it as the next turn once the rejected turn winds
            // down and the session returns to idle (parity with #1740).
            const [deniedPermissions, dismissedQuestions] = await Promise.all([
                sessionActions.dismissOpenPermissionsForSession(currentSessionId),
                sessionActions.dismissOpenQuestionsForSession(currentSessionId),
            ]);
            if (deniedPermissions || dismissedQuestions) {
                await handleQueueMessage();
                return;
            }
        }

        const branchCheckoutReceipt = draftBranchCheckout.getReceipt(branchIntent);
        const sendMessageOptions = capturedTarget
            ? { target: capturedTarget, ...(delivery ? { delivery } : {}) }
            : delivery || branchCheckoutReceipt || worktreeCreationReceipt
                ? {
                    ...(delivery ? { delivery } : {}),
                    ...(branchCheckoutReceipt ? { branchCheckoutReceipt } : {}),
                    ...(worktreeCreationReceipt ? {
                        worktreeCreationReceipt,
                        draftSnapshot: draftAtSend,
                    } : {}),
                }
                : undefined;

        const syntheticParts = consumePendingSyntheticParts();

        const availableSkillNames = new Set(
            useSkillsStore.getState().skills.map((skill) => skill.name),
        );

        const outgoing = buildOutgoingMessage({
            queued: queuedMessagesToSend,
            composerText: !queuedOnly && inputSnapshot.hasContent ? inputSnapshot.message : null,
            composerAttachments: attachedFiles,
            syntheticTexts: syntheticParts?.map((part) => part.text) ?? [],
        }, {
            parseAgentMention: (text) => {
                const { sanitizedText, mention } = parseAgentMentions(text, agents);
                return { text: sanitizedText, agentName: mention?.name };
            },
            extractFileMentions: (text) => {
                const { sanitizedText, attachments } = extractInlineFileMentions(text);
                return { text: sanitizedText, attachments };
            },
            sanitizeAttachments: sanitizeAttachmentsForSend,
            collectSkillNames: (text) => collectInlineSkillMentions(text, availableSkillNames),
            buildSkillInstruction: buildSkillMentionInstruction,
        });

        let primaryText = outgoing.primaryText;
        const { primaryAttachments, additionalParts, agentMentionName } = outgoing;

        if (outgoing.isEmpty) return;

        const capturedWorktreeDraftIsCurrent = !worktreeCreationReceipt || (
            useSessionUIStore.getState().newSessionDraft === draftAtSend
            && useSessionUIStore.getState().currentSessionId === null
        );
        if (!queuedOnly) {
            // Always consume the captured draft. If navigation happened while
            // the worktree was being created, leave the newly selected
            // session's composer alone. Text is cleared optimistically while
            // queued messages and attachments stay put until prompt dispatch
            // succeeds (cleared in the success handler).
            persistDraftImmediately(chatDraftIdentity, '');
            if (capturedWorktreeDraftIsCurrent) {
                setMessage('');
                confirmedMentionsRef.current.clear();
                messageHistory.reset();
                // Attachments stay visible until prompt dispatch succeeds.
                setExpandedInput(false);
            }
        }

        if (isMobile && capturedWorktreeDraftIsCurrent) {
            composerRef.current?.blur();
        }

        // Local slash commands, normal mode only.
        const parsedCommand = inputMode === 'normal' ? parseSlashCommand(primaryText) : null;
        if (parsedCommand) {
            const handled = await tryExecuteLocalSlashCommand({
                command: parsedCommand,
                currentSessionId,
                scrollToBottom,
                setTimelineDialogOpen,
                onUndoSession: async (id) => {
                    await useSessionUIStore.getState().handleSlashUndo(id);
                },
                onRedoSession: async (id) => {
                    await useSessionUIStore.getState().handleSlashRedo(id);
                },
                onCompactSession: async (id, argument) => {
                    try {
                        await sessionActions.waitForConnectionOrThrow();
                        await sessionActions.compactSession(id, argument);
                    } catch (error) {
                        toast.error(getSubmitErrorMessage(error, "Failed to compact session"));
                    }
                },
            });
            if (handled) return;
        }

        const currentSessionDirectory = capturedTarget?.directory ?? currentDirectory;
        const shouldAddResponseStyle = newSessionDraftOpen || (currentSessionId ? !hasUserMessages(currentSessionId, currentSessionDirectory) : false);
        if (shouldAddResponseStyle) {
            const responseStyleInstruction = await fetchResponseStyleInstruction().catch(() => null);
            if (responseStyleInstruction) {
                additionalParts.push({
                    text: wrapSystemReminder(responseStyleInstruction),
                    synthetic: true,
                });
            }
        }

        if (inputMode !== 'shell') {
            try {
                const expandText = useSnippetsStore.getState().expandText;
                primaryText = await expandText(primaryText);
                for (const part of additionalParts) {
                    if (!part.synthetic) part.text = await expandText(part.text);
                }
            } catch (error) {
                console.warn('[ChatInput] Failed to expand snippets, sending original text:', error);
            }
        }

        // Collect all attachments for error recovery
        const allAttachments = [
            ...primaryAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];
        const composerAttachmentIds = attachedFiles.map((attachment) => attachment.id);

        const sendPromise = sendMessage(
            primaryText,
            providerIdToSend,
            modelIdToSend,
            agentNameToSend,
            primaryAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            variantToSend,
            inputMode,
            sendMessageOptions,
        );
        draftBranchCheckout.clearReceipt();
        if (typeof window === 'undefined') {
            scrollToBottom?.();
        } else {
            window.requestAnimationFrame(() => {
                scrollToBottom?.();
            });
        }

        void sendPromise.then(() => {
            draftWorktreeCreation.clearReceipt();
            if (capturedTarget && queuedMessageId) {
                removeFromQueue(capturedTarget, queuedMessageId);
            } else if (capturedTarget && hasQueuedMessages) {
                clearQueue(capturedTarget);
            }
            if (composerAttachmentIds.length > 0) detachAttachedFiles(composerAttachmentIds);
        }).catch((error: unknown) => {
            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();

            console.error('Message send failed:', rawMessage || error);

            const currentInput = composerRef.current?.getValue() ?? messageRef.current;
            if (newSessionDraftOpen && inputSnapshot.message && (!currentInput || currentInput === inputSnapshot.message)) {
                setMessage(inputSnapshot.message);
                writeChatDraft(chatDraftIdentity, inputSnapshot.message, confirmedMentionsRef.current);
            }

            const isSoftNetworkError =
                normalized.includes('timeout') ||
                normalized.includes('timed out') ||
                normalized.includes('may still be processing') ||
                normalized.includes('being processed') ||
                normalized.includes('failed to fetch') ||
                normalized.includes('networkerror') ||
                normalized.includes('network error') ||
                normalized.includes('gateway timeout') ||
                normalized === 'failed to send message';

            if (normalized.includes('payload too large') || normalized.includes('413') || normalized.includes('entity too large')) {
                toast.error("Attachments are too large to send. Please try reducing the number or size of images.");
                return;
            }

            if (isSoftNetworkError) {
                if (allAttachments.length > 0) toast.error("Failed to send attachments. Try fewer files or smaller images.");
                return;
            }

            if (normalized.includes('runtime changed')) {
                toast.error("Message failed to send. Attachments remain available.");
                return;
            }

            toast.error(rawMessage || "Message failed to send. Attachments remain available.");
        });

        if (!isMobile) {
            composerRef.current?.focus();
        }
    };

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = handleSubmit;

    // Primary action for send/queue button — respects selected follow-up behavior
    const handlePrimaryAction = React.useCallback(() => {
        const inputSnapshot = getCurrentInputSnapshot();
        const canQueue = inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && sessionPhase !== 'idle';
        if (followUpBehavior === 'queue' && canQueue) {
            void handleQueueMessage();
        } else if (followUpBehavior === 'steer' && canQueue) {
            void handleSubmitRef.current({ delivery: 'steer' });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, sessionPhase, followUpBehavior, handleQueueMessage]);

    // Draft welcome presets: submit immediately.
    const submitPresetPrompt = React.useCallback((text: string, type: 'command' | 'skill') => {
        // The text goes straight into the submit (see SubmitOptions.presetText)
        // so preset chips do not need to stage text through the editor first.
        const draft = (composerRef.current?.getValue() ?? messageRef.current).trim();
        // Pi recognizes slash commands only when their arguments follow
        // the command on the same line. Skills retain the multiline prompt form.
        const presetText = draft ? `${text}${type === 'command' ? ' ' : '\n'}${draft}` : text;
        void handleSubmitRef.current({ presetText });
    }, []);


    // Preset chips rendered outside this component (e.g. under the welcome
    // message on narrow surfaces) request a submit via the input store; consume
    // it here so it routes through the same command-aware submit path.
    React.useEffect(() => {
        if (pendingPresetSubmit == null) return;
        const text = useInputStore.getState().consumePendingPresetSubmit();
        if (text) submitPresetPrompt(text.text, text.type);
    }, [pendingPresetSubmit, submitPresetPrompt]);

    const updateAutocompleteState = React.useCallback((
        value: string,
        cursorPosition: number,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
        insertedText?: string,
    ) => {
        const trigger = resolveAutocompleteTrigger(value, cursorPosition, {
            inputMode,
            inputSource,
            insertedText,
        });
        setOpenAutocomplete(trigger?.kind ?? null);
        setAutocompleteQuery(trigger?.query ?? '');
    }, [inputMode]);

    const handleKeyDown = useComposerKeyNavigation({
        inputMode,
        setInputMode,
        message,
        setMessage,
        openAutocomplete,
        commandRef,
        skillRef,
        snippetRef,
        mentionRef,
        composerRef,
        messageHistory,
        updateAutocompleteState,
        isMobile,
        hasContent,
        currentSessionId,
        sessionPhase,
        followUpBehavior,
        handleSubmit,
        handleQueueMessage,
    });

    // Focus mode places the open picker at the caret; elsewhere each picker
    // anchors to the composer itself.
    const {
        position: autocompleteOverlayPosition,
        update: updateAutocompleteOverlayPosition,
    } = useAutocompletePosition({
        enabled: isDesktopExpanded,
        openAutocomplete,
        message,
        editorRef: composerRef,
        containerRef: dropZoneRef,
    });

    const startAbortIndicator = React.useCallback(() => {
        if (abortTimeoutRef.current) {
            clearTimeout(abortTimeoutRef.current);
            abortTimeoutRef.current = null;
        }

        setShowAbortStatus(true);

        abortTimeoutRef.current = setTimeout(() => {
            setShowAbortStatus(false);
            abortTimeoutRef.current = null;
        }, 1800);
    }, []);

    const handleAbort = React.useCallback(() => {
        clearAbortPrompt();
        startAbortIndicator();

        void abortCurrentOperation(currentSessionId || undefined);
    }, [abortCurrentOperation, clearAbortPrompt, currentSessionId, startAbortIndicator]);

    const insertTextAtSelection = React.useCallback((
        text: string,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
    ) => {
        if (!text) {
            return;
        }

        const editor = composerRef.current;
        if (!editor) {
            // The editor may be temporarily unavailable during a surface remount;
            // append to the state it will be seeded from.
            const nextValue = message + text;
            setMessage(nextValue);
            updateAutocompleteState(nextValue, nextValue.length, inputSource, text);
            return;
        }

        const { start, end } = editor.getSelection();
        const nextValue = `${message.substring(0, start)}${text}${message.substring(end)}`;
        const cursorPosition = start + text.length;

        // One dispatch places both the text and the caret, so there is no
        // frame where the caret sits at a stale offset.
        editor.insertText(text);
        updateAutocompleteState(nextValue, cursorPosition, inputSource, text);
    }, [message, updateAutocompleteState]);

    const handleStartDictation = React.useCallback(() => {
        const fallback = messageRef.current.length;
        dictationSelectionRef.current = composerRef.current?.getSelection() ?? { start: fallback, end: fallback };
        closeAutocomplete();
        void dictation.start().catch(() => {});
    }, [closeAutocomplete, dictation]);

    const handleFinishDictation = React.useCallback(() => {
        void dictation.finish().then((transcript) => {
            const current = messageRef.current;
            const snapshot = dictationSelectionRef.current;
            const start = Math.min(Math.max(0, snapshot.start), current.length);
            const end = Math.min(Math.max(start, snapshot.end), current.length);
            const insertion = withInlineInsertionBoundaries(transcript.trim(), current.slice(0, start), current.slice(end));
            if (!insertion) return;
            const editor = composerRef.current;
            if (editor) {
                editor.replaceRange(start, end, insertion, start + insertion.length);
                editor.focus({ preventScroll: true });
            } else {
                const next = `${current.slice(0, start)}${insertion}${current.slice(end)}`;
                setMessage(next);
                updateAutocompleteState(next, start + insertion.length, 'manual', insertion);
            }
        }).catch(() => {});
    }, [dictation, updateAutocompleteState]);

    React.useEffect(() => {
        if (dictation.state !== 'error' || !dictation.error || dictationErrorRef.current === dictation.error) return;
        dictationErrorRef.current = dictation.error;
        toast.error(dictation.error);
    }, [dictation.error, dictation.state]);

    const clearFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = false;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }
    }, []);

    const markFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = true;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
        }
        suppressNextFileMentionPasteTimeoutRef.current = setTimeout(() => {
            suppressNextFileMentionPasteRef.current = false;
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }, 700);
    }, []);

    const handleComposerChange = ({ value, selection, fromPaste, insertedText }: ComposerChange) => {
        const pastedInsertedText = fromPaste ? insertedText : '';
        const isPasteInput = pastedInsertedText.includes('@') || suppressNextFileMentionPasteRef.current;
        if (suppressNextFileMentionPasteRef.current) {
            clearFileMentionPasteSuppression();
        }
        const inputSource: FileMentionAutocompleteInputSource = isPasteInput ? 'paste' : 'manual';

        // A leading `!` switches the composer into shell mode and is consumed.
        if (inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, selection.start - 1);
            setInputMode('shell');
            setMessage(shellCommand);
            closeAutocomplete();
            requestAnimationFrame(() => composerRef.current?.setSelection(nextCursor));
            return;
        }

        setMessage(value);
        updateAutocompleteState(value, selection.start, inputSource, pastedInsertedText);
    };

    React.useEffect(() => {
        return () => {
            clearFileMentionPasteSuppression();
        };
    }, [clearFileMentionPasteSuppression]);

    const handlePaste = useComposerPaste({
        inputMode,
        enabled: Boolean(currentSessionId || newSessionDraftOpen),
        composerRef,
        message,
        setMessage,
        insertTextAtSelection,
        updateAutocompleteState,
        markFileMentionPasteSuppression,
        attachedFiles,
        addAttachedFile,
    });

    // Mention paths are shown relative to the project the chat searches.
    const toMentionPath = React.useCallback(
        (absolutePath: string) => toProjectRelativeMentionPath(absolutePath, chatSearchDirectory || ""),
        [chatSearchDirectory],
    );

    const {
        handleFileSelect,
        handleAgentSelect,
        handleSkillSelect,
        handleSnippetSelect,
        handleCommandSelect,
    } = useComposerAutocompleteHandlers({
        composerRef,
        message,
        setMessage,
        updateAutocompleteState,
        closeAutocomplete,
        confirmedMentionsRef,
        toMentionPath,
    });

    React.useEffect(() => {

        if (currentSessionId && composerRef.current && !isMobile) {
            composerRef.current.focus();
        }
    }, [currentSessionId, isMobile]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsPanel(null);
        }
    }, [isMobile]);

    React.useEffect(() => {
        if (abortPromptSessionId && abortPromptSessionId !== currentSessionId) {
            clearAbortPrompt();
        }
    }, [abortPromptSessionId, currentSessionId, clearAbortPrompt]);

    React.useEffect(() => {
        canAcceptDropRef.current = Boolean(currentSessionId || newSessionDraftOpen);
    }, [currentSessionId, newSessionDraftOpen]);

    const {
        isDragging,
        isInternalDrag,
        handleDragEnter,
        handleDragOver,
        handleDragLeave,
        handleDragEnd,
        handleDrop,
        handleDropCapture,
    } = useComposerDrop({
        enabled: Boolean(currentSessionId || newSessionDraftOpen),
        composerRef,
        messageRef,
        cursorPosRef,
        confirmedMentionsRef,
        setMessage,
        addAttachedFile,
    });

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        const list = Array.isArray(files) ? files : Array.from(files);
        const results = await Promise.all(list.map(async (file) => {
            try {
                return await addAttachedFile(file);
            } catch (error) {
                console.error('File attach failed', error);
                return false;
            }
        }));
        if (list.length > 0 && !results.some(Boolean)) {
            toast.error("Failed to attach file");
        }
    }, [addAttachedFile]);

    const handlePickLocalFiles = React.useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const handleLocalFileSelect = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;
        await attachFiles(files);
        event.target.value = '';
    }, [attachFiles]);

    const footerGapClass = 'gap-x-1.5 gap-y-0';
    const composerStatusExtrasEnabled = true;
    const showDraftTargetSelectors = (newSessionDraftOpen || Boolean(currentSessionId)) && !isMiniChatSurface;

    // Which project and directory a new session will target.
    const {
        projects: draftProjects,
        selectedDraftProject,
        selectedDraftBranchLabel,
        selectedBranchName,
        draftBranchItems,
        isDiscoveringDraftBranches,
        shouldShowDraftBranchSelector,
        worktreeMode,
        handleDraftProjectChange,
        handleDraftBranchChange,
        handleWorktreeModeChange,
    } = useDraftTarget(showDraftTargetSelectors);

    const showComposerTargetRow = Boolean(
        showDraftTargetSelectors && selectedDraftProject && (newSessionDraftOpen || shouldShowDraftBranchSelector),
    );
    const hasPendingChanges = React.useMemo(() => {
        if (isMiniChatSurface) {
            return false;
        }
        if (isGitRepo !== true || !currentGitStatus || currentGitStatus.isClean) {
            return false;
        }
        return extractGitChangedFiles(currentGitStatus.files, currentGitStatus.diffStats, currentDirectory).length > 0;
    }, [currentDirectory, currentGitStatus, isGitRepo, isMiniChatSurface]);
    const pendingChangesBar = composerStatusExtrasEnabled && hasPendingChanges
        ? <PendingChangesBar align={showComposerTargetRow ? 'end' : 'start'} />
        : null;


    // Mobile keeps one full composer mounted. The shell only owns platform
    // focus/keyboard corrections and overlay hand-offs.
    const mobileShell = useMobileComposerShell({
        isMobile,
        editorRef: composerRef,
        formRef: composerFormRef,
        controlsPanelOpen: Boolean(mobileControlsPanel),
        attachMenuOpen: mobileAttachMenuOpen,
    });
    const mobileTextareaFocused = mobileShell.focused;




    const openMobileAttachSheet = React.useCallback(() => {
        // Mark the sheet open BEFORE the blur so keyboard restoration sees the
        // overlay when the keyboard-close lands. The trigger button blocks the
        // tap's own focus transfer, so the keyboard must be dismissed here.
        setMobileAttachMenuOpen(true);
        composerRef.current?.blur();
    }, []);


    // Reset the picker search whenever a draft picker sheet opens/closes.
    React.useEffect(() => {
        setMobileDraftPickerQuery('');
    }, [mobileDraftPicker]);

    // Mobile browsers pan the visual viewport instead of resizing the layout,
    // so the composer form is pinned to it explicitly.
    useMobileViewportPin({
        isMobile,
        isFullscreen: isMobileExpanded,
        isDraftScreen: newSessionDraftOpen,
        isFocused: mobileTextareaFocused,
        formRef: composerFormRef,
        editorRef: composerRef,
    });

    const footerPaddingClass = isMobile
        ? 'px-1.5 py-1.5'
        : isInlineComposer
            ? 'px-1.5 py-1'
            : 'px-3 py-2';
    const buttonSizeClass = isMobile ? 'h-8 w-8' : 'h-6 w-6';
    const sendIconSizeClass = isMobile ? 'h-4 w-4' : 'h-4 w-4';
    const stopIconSizeClass = isMobile ? 'h-6 w-6' : 'h-5 w-5';
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : 'h-[18px] w-[18px]';

    const iconButtonBaseClass = 'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed';
    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);
    React.useEffect(() => {
        const pendingAbortBanner = Boolean(abortPromptSessionId) && abortPromptSessionId === currentSessionId;
        if (!prevWasAbortedRef.current && pendingAbortBanner && !showAbortStatus) {
            startAbortIndicator();
            if (currentSessionId) {
                acknowledgeSessionAbort(currentSessionId);
            }
        }
        prevWasAbortedRef.current = pendingAbortBanner;
    }, [
        abortPromptSessionId,
        acknowledgeSessionAbort,
        currentSessionId,
        showAbortStatus,
        startAbortIndicator,
    ]);

    React.useEffect(() => {
        return () => {
            if (abortTimeoutRef.current) {
                clearTimeout(abortTimeoutRef.current);
                abortTimeoutRef.current = null;
            }
        };
    }, []);

    return (
        <>
        <form
            ref={composerFormRef}
            onSubmit={(e) => { e.preventDefault(); handlePrimaryAction(); }}
            className={cn(
                "relative w-full pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobileExpanded && 'flex h-full min-h-0 flex-col pt-2',
                isMobile && 'bottom-safe-area oc-mobile-composer'
            )}
            style={isMobile && inputBarOffset > 0 ? { marginBottom: `${inputBarOffset}px` } : undefined}
        >
            <div className={cn('chat-input-column relative overflow-visible', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                <QueuedMessageChips
                    onEditMessage={handleQueuedMessageEdit}
                    onSendMessage={handleQueuedMessageSend}
                />
                <RevertedMessageDock
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                />
                <MemoStatusRow
                    showAbortStatus={showAbortStatus}
                    showAssistantStatus={false}
                    showTodos={composerStatusExtrasEnabled}
                    leftAccessory={showComposerTargetRow || newSessionDraftOpen || !pendingChangesBar
                        ? null
                        : pendingChangesBar}
                />
                {!isMobileForDraft && showDraftTargetSelectors && selectedDraftProject && (newSessionDraftOpen || shouldShowDraftBranchSelector) ? (
                    <DraftTargetSelectors
                        projects={draftProjects}
                        selectedProject={selectedDraftProject}
                        selectedBranchName={selectedBranchName}
                        selectedBranchLabel={selectedDraftBranchLabel}
                        branchOptions={draftBranchItems}
                        branchInteractive={newSessionDraftOpen}
                        branchLoading={isDiscoveringDraftBranches}
                        showBranchSelector={shouldShowDraftBranchSelector}
                        showProjectSelector={newSessionDraftOpen}
                        showWorktreeSelector={newSessionDraftOpen && shouldShowDraftBranchSelector}
                        worktreeMode={worktreeMode}
                        endAccessory={pendingChangesBar}
                        onProjectChange={handleDraftProjectChange}
                        onBranchChange={handleDraftBranchChange}
                        onWorktreeModeChange={handleWorktreeModeChange}
                        theme={currentTheme}
                    />
                ) : null}
                {isMobileForDraft && showDraftTargetSelectors && selectedDraftProject && (newSessionDraftOpen || shouldShowDraftBranchSelector) ? (
                    <MobileDraftTargetTriggers
                        selectedProject={selectedDraftProject}
                        selectedBranchLabel={selectedDraftBranchLabel}
                        branchInteractive={newSessionDraftOpen}
                        showBranchSelector={shouldShowDraftBranchSelector}
                        showProjectSelector={newSessionDraftOpen}
                        showWorktreeSelector={newSessionDraftOpen && shouldShowDraftBranchSelector}
                        worktreeMode={worktreeMode}
                        onWorktreeModeChange={handleWorktreeModeChange}
                        endAccessory={pendingChangesBar}
                        theme={currentTheme}
                        onOpenPicker={setMobileDraftPicker}
                    />
                ) : null}
                {draftWorktreeCreation.state ? (
                    <div
                        className={cn(
                            'mx-2 mb-2 flex min-h-16 items-center gap-3 rounded-xl px-3 py-2 typography-meta',
                            draftWorktreeCreation.state.phase === 'failed'
                                ? 'bg-[var(--status-error-background)] text-[var(--status-error-foreground)]'
                                : 'bg-[var(--surface-muted)] text-muted-foreground',
                        )}
                        role={draftWorktreeCreation.state.phase === 'failed' ? 'alert' : 'status'}
                    >
                        {draftWorktreeCreation.state.phase !== 'failed' ? (
                            <AgentThinkingLoader variant="inline" text={null} animationType="spinner" />
                        ) : null}
                        <div className="min-w-0 flex-1">
                            <p className="typography-ui-label">{draftWorktreeCreation.state.label}</p>
                            {draftWorktreeCreation.state.phase !== 'failed' ? (
                                <p className="mt-0.5 text-xs opacity-70">Running in background — you can navigate away</p>
                            ) : null}
                            {draftWorktreeCreation.state.error ? (
                                <p className="mt-0.5 break-words">{draftWorktreeCreation.state.error}</p>
                            ) : null}
                        </div>
                        {draftWorktreeCreation.state.phase === 'failed' ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => draftWorktreeCreation.dismissFailed()}
                                aria-label="Dismiss error"
                            >
                                Dismiss
                            </Button>
                        ) : null}
                    </div>
                ) : null}
                <div
                    className={cn(
                        !isMobile && 'contents',
                        isMobile && 'relative',
                        isMobileExpanded && 'flex min-h-0 flex-1 flex-col',
                    )}
                >
                <>
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isComposerExpanded && 'flex-1 min-h-0',
                        isDesktopStackedComposer && !isComposerExpanded && 'min-h-[7rem]',
                        "border border-border/80",
                        "shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]",
                        "focus-within:ring-1",
                        inputMode === 'shell'
                            ? 'focus-within:ring-[color:color-mix(in_srgb,var(--status-info)_45%,transparent)]'
                            : 'focus-within:ring-primary/30',
                        isDragging && "ring-2 ring-primary ring-offset-2"
                    )}
                    style={{
                        borderRadius: chatInputRadius,
                        backgroundColor: currentTheme?.colors?.surface?.subtle,
                    }}
                    ref={dropZoneRef}
                    onDropCapture={handleDropCapture}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                >
                    {isDragging && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 rounded-xl">
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title={"Attach files"}
                                        aria-label={"Attach files"}
                                    >
                                        <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">
                                    {isInternalDrag ? "Drop to insert as mention" : "Drop files here to attach"}
                                </p>
                            </div>
                        </div>
                    )}

                    <ComposerAutocompletePopups
                        open={openAutocomplete}
                        query={autocompleteQuery}
                        overlayPosition={isDesktopExpanded ? autocompleteOverlayPosition : null}
                        commandRef={commandRef}
                        skillRef={skillRef}
                        snippetRef={snippetRef}
                        mentionRef={mentionRef}
                        onCommandSelect={handleCommandSelect}
                        onSkillSelect={handleSkillSelect}
                        onSnippetSelect={handleSnippetSelect}
                        onFileSelect={handleFileSelect}
                        onAgentSelect={handleAgentSelect}
                        onClose={closeAutocomplete}
                    />
                    <ComposerFooter
                        isMobile={isMobile}
                        isInline={isInlineComposer}
                        alignToolsEnd={composerVisualLines > 1}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        messageLength={message.length}
                        leadingExtra={isDesktopStackedComposer || isMobile ? (
                            <MemoModelControls
                                keepLabels
                                className="w-max shrink-0"
                                mobilePanel={isMobile ? mobileControlsPanel : undefined}
                                onMobilePanelChange={isMobile ? setMobileControlsPanel : undefined}
                            />
                        ) : null}
                        trailingExtra={dictationActive ? null : (
                            <ComposerVoiceButton
                                available={dictation.available}
                                disabled={(!currentSessionId && !newSessionDraftOpen) || Boolean(draftWorktreeCreation.state && draftWorktreeCreation.state.phase !== 'failed')}
                                className={footerIconButtonClass}
                                iconClassName={iconSizeClass}
                                onStart={handleStartDictation}
                            />
                        )}
                        actionsOverride={dictationActive ? (
                            <ComposerVoiceActions
                                state={dictation.state}
                                elapsedSeconds={dictation.elapsedSeconds}
                                buttonClassName={footerIconButtonClass}
                                iconClassName={iconSizeClass}
                                isMobile={isMobile}
                                onCancel={dictation.cancel}
                                onDone={handleFinishDictation}
                            />
                        ) : undefined}
                        radius={chatInputRadius}
                        footerPaddingClass={footerPaddingClass}
                        footerGapClass={footerGapClass}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        canSend={canSend && !Boolean(draftWorktreeCreation.state && draftWorktreeCreation.state.phase !== 'failed')}
                        disabledReason={attachmentGateMessage}
                        canAbort={canAbort}
                        hasContent={Boolean(hasContent)}
                        onOpenSettings={onOpenSettings}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onPrimaryAction={handlePrimaryAction}
                        onQueueMessage={handleQueueMessage}
                        onAbort={handleAbort}
                    >
                    {dictationActive ? (
                        <ComposerVoiceInput
                            state={dictation.state}
                            subscribeLevel={dictation.subscribeLevel}
                        />
                    ) : (
                    <div className={cn("overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                        <div className={cn('relative z-10 flex flex-wrap items-center gap-1', isInlineComposer ? 'px-0' : 'px-3 pt-1')}>
                            <AttachedFilesList onShowPopup={handleShowAttachmentPreview} />
                        </div>
                        <div
                            className={cn("relative overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                            onDragEnter={handleDragEnter}
                            onDragOver={handleDragOver}
                            onDropCapture={handleDropCapture}
                            onDrop={handleDrop}
                            onDragEnd={handleDragEnd}
                        >
                            <ComposerEditor
                                ref={composerRef}
                                viewStore={composerViewStore}
                                data-testid="chat-input"
                                value={message}
                                languageContext={languageContext}
                                onChange={handleComposerChange}
                                onKeyDown={(event) => {
                                    handleKeyDown(event);
                                    return event.defaultPrevented;
                                }}
                                onPaste={handlePaste}
                                onSelectionChange={(selection) => {
                                    cursorPosRef.current = selection.start;
                                    updateAutocompleteOverlayPosition();
                                }}
                                onVisualLineCount={(count) => {
                                    setComposerVisualLines((previous) => (previous === count ? previous : count));
                                }}
                                onFocus={mobileShell.onEditorFocus}
                                onBlur={mobileShell.onEditorBlur}
                                placeholder={currentSessionId || newSessionDraftOpen
                                    ? inputMode === 'shell'
                                        ? "Enter shell command..."
                                        : isNewSessionStackedComposer
                                            ? "Plan, build, / for skills, @ for context"
                                            : (useCompactChatPlaceholder ? "Use @ / ! # for helpers" : "@ for files/agents; / for commands and skills; ! for shell; # for snippets")
                                    : "Select or create a session to start chatting"}
                                editable={Boolean(currentSessionId || newSessionDraftOpen) && !Boolean(draftWorktreeCreation.state && draftWorktreeCreation.state.phase !== 'failed')}
                                autoCorrect={false}
                                autoCapitalize="none"
                                spellCheck={isMobile || inputSpellcheckEnabled}
                                fillContainer={isComposerExpanded}
                                maxLines={isMobile ? MAX_MOBILE_COMPOSER_LINES : MAX_VISIBLE_COMPOSER_LINES}
                                boundSelector={isMobile ? '[data-composer-bound]' : undefined}
                                boundGapPx={MOBILE_COMPOSER_BOUND_GAP_PX}
                                className={cn(
                                    'relative z-10',
                                    isInlineComposer
                                        ? 'min-h-0 px-1.5 py-1.5'
                                        : 'min-h-[52px] px-3',
                                    isComposerExpanded
                                        ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4')
                                        : isMobile
                                            ? 'py-2.5'
                                            : isInlineComposer
                                                ? undefined
                                                : 'pt-3 pb-2',
                                    inputMode === 'shell' ? 'font-mono' : 'typography-markdown md:typography-ui-label',
                                )}
                            />
                        </div>
                    </div>
                    )}
                    </ComposerFooter>

                </div>
                </>
                </div>
                {isDesktopStackedComposer || isMobile ? null : (
                    <div className="mt-1.5 flex w-full shrink-0 items-center pl-2">
                        <MemoModelControls className="w-full min-w-0" />
                    </div>
                )}
            </div>
            {newSessionDraftOpen && !isDesktopExpanded && !isMobile && !isMiniChatSurface ? (
                <DraftPresetChips
                    onSubmit={(starter) => submitPresetPrompt(starter.submitText, starter.ref.type)}
                    className="chat-input-column mt-3"
                />
            ) : null}
        </form>

        {attachmentPreviewMounted ? (
            <React.Suspense fallback={null}>
                <ToolOutputDialog
                    popup={attachmentPreview}
                    onOpenChange={handleAttachmentPreviewOpenChange}
                    isMobile={isMobile}
                />
            </React.Suspense>
        ) : null}

        {/* Single always-mounted picker input. Keeping it outside composer
            controls prevents an overlay/control remount from detaching the native
            file input while the OS picker is open. */}
        <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleLocalFileSelect}
            accept={ATTACHMENT_ACCEPT}
        />

        {/* Mobile attachment sheet: replaces the dropdown (which stole focus and
            dismissed the keyboard) and leaves room for more actions later. */}
        {isMobile ? (
            <MobileOverlayPanel
                open={mobileAttachMenuOpen}
                title={"Add attachment"}
                onClose={() => setMobileAttachMenuOpen(false)}
            >
                <div className="flex flex-col px-3 pb-4 pt-1">
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // The native file/photo picker takes over next — restoring
                            // the keyboard in between would flash it open and shut.
                            mobileShell.cancelOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(handlePickLocalFiles);
                        }}
                    >
                        <Icon name="attachment-2" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {"Attach files"}
                    </button>
                </div>
            </MobileOverlayPanel>
        ) : null}

        <DraftBranchCheckoutDialog
            state={draftBranchCheckout.dialogState}
            onCancel={draftBranchCheckout.cancel}
            onConfirm={() => { void draftBranchCheckout.confirm(); }}
        />

        {/* Mobile draft target pickers: bottom sheets replacing the inline
            project/branch Selects (which desktop keeps). */}
        {isMobileForDraft && showDraftTargetSelectors && selectedDraftProject ? (
            <MobileDraftTargetSheets
                projects={draftProjects}
                selectedProject={selectedDraftProject}
                selectedBranchName={selectedBranchName}
                selectedBranchLabel={selectedDraftBranchLabel}
                branchOptions={draftBranchItems}
                branchInteractive={newSessionDraftOpen}
                branchLoading={isDiscoveringDraftBranches}
                showBranchSelector={shouldShowDraftBranchSelector}
                showProjectSelector={newSessionDraftOpen}
                showWorktreeSelector={newSessionDraftOpen && shouldShowDraftBranchSelector}
                worktreeMode={worktreeMode}
                onProjectChange={handleDraftProjectChange}
                onBranchChange={handleDraftBranchChange}
                onWorktreeModeChange={handleWorktreeModeChange}
                theme={currentTheme}
                openPicker={mobileDraftPicker}
                onOpenPickerChange={setMobileDraftPicker}
                query={mobileDraftPickerQuery}
                onQueryChange={setMobileDraftPickerQuery}
            />
        ) : null}
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);
