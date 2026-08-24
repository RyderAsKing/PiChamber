/* eslint-disable */
// @ts-nocheck
import React from 'react';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useInputStore } from '@/sync/input-store';
import {
    ATTACHMENT_ACCEPT,
    getUnsupportedAttachmentInputs,
    type AttachmentInputModality,
} from '@/sync/attachment-files';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
import { buildLinkedIssue } from '@/lib/linkedIssues';
import { useUserMessageHistory } from "@/sync/sync-context";
import { getInlineCommentDraftKey, useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { renderMagicPrompt } from '@/lib/magicPrompts';
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
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
import { useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { isIMECompositionEvent } from '@/lib/ime';
import type { MobileControlsPanel } from './mobileControlsUtils';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { GitHubIssuePickerDialog } from '@/components/session/GitHubIssuePickerDialog';
import { GitHubPrPickerDialog } from '@/components/session/GitHubPrPickerDialog';
import { Icon } from "@/components/icon/Icon";
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
import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
} from './attachmentCitations';
import type { FileMentionAutocompleteInputSource } from './fileMentionAutocompleteState';
import {
    classifyMention,
    scanMentions,
} from './composer/language/mentions';
import { collectKnownTokenNames } from './composer/language/prefixTokens';
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
    buildImagePasteInsertion,
    shouldWrapSelectionAsLink,
    withInlineInsertionBoundaries,
} from './composer/text';
import {
    collectDroppedFiles,
    hasDraggedFiles,
} from './composer/attachments/dataTransfer';
import {
    normalizePath,
    toProjectRelativeMentionPath,
    toServerFileUrl,
} from './composer/attachments/filePaths';
import { buildOutgoingMessage } from './composer/submit/buildOutgoingMessage';
import {
    buildCommandVariables,
    canRunCommand,
    findMagicPromptCommand,
    parseSlashCommand,
} from './composer/submit/slashCommands';
import { useAutocompletePosition } from './composer/state/useAutocompletePosition';
import { useMessageHistory } from './composer/state/useMessageHistory';
import { useComposerDraft } from './composer/state/useComposerDraft';
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
import { MobilePillComposer } from './composer/ui/MobilePillComposer';
import { ComposerContextChips } from './composer/ui/ComposerContextChips';
import { LinkedReferenceRow } from './composer/ui/LinkedReferenceRow';
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

const renameFileForAttachmentCitation = (file: File, filename: string): File => {
    if (file.name === filename) {
        return file;
    }

    return new File([file], filename, {
        type: file.type,
        lastModified: file.lastModified,
    });
};

const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

/**
 * Skills the user named inline with `/name`. Mobile keyboards auto-capitalize
 * and auto-correct the token after the slash ("/Skill"), so the match must be
 * case-insensitive. The canonical registry name is returned so the synthetic
 * instruction always names a real skill.
 */
const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] => {
    if (skillNames.size === 0) return [];
    const lowerSet = new Set<string>();
    const canonicalByLower = new Map<string, string>();
    for (const name of skillNames) {
        const lower = name.toLowerCase();
        lowerSet.add(lower);
        if (!canonicalByLower.has(lower)) canonicalByLower.set(lower, name);
    }
    const matched = collectKnownTokenNames(text, '/', lowerSet, 'case-insensitive');
    const canonical = matched.map((name) => canonicalByLower.get(name.toLowerCase()) ?? name);
    // De-duplicate case-variant repeats of the same skill ("/Skill /skill" → one entry).
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const name of canonical) {
        const lower = name.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        deduped.push(name);
    }
    return deduped;
};

const buildSkillMentionInstruction = (skillNames: string[]): string | null => {
    if (skillNames.length === 0) return null;
    const formatted = skillNames.map((name) => `/${name}`).join(', ');
    return `The user explicitly mentioned these skills in their message: ${formatted}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`;
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
        ? sessionState.newSessionDraft.bootstrapPendingDirectory ?? sessionState.newSessionDraft.directoryOverride
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
    const [isDragging, setIsDragging] = React.useState(false);
    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
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
    // The mobile composer swaps between the collapsed pill and the full
    // composer, which unmounts the editor. Building a CodeMirror view is far
    // from free, and it would happen inside the tap that expands the pill —
    // before the browser may paint the swap. The store keeps one view alive for
    // as long as the composer itself is mounted.
    const composerViewStore = React.useRef(createComposerEditorViewStore()).current;
    React.useEffect(() => () => {
        composerViewStore.view?.destroy();
        composerViewStore.view = null;
    }, [composerViewStore]);
    const composerFormRef = React.useRef<HTMLFormElement | null>(null);
    const cursorPosRef = React.useRef(0);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const dragEnterCountRef = React.useRef(0);
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
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());

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
    const clearAttachedFiles = useInputStore((s) => s.clearAttachedFiles);
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
    const draftWorktreeCreation = useDraftWorktreeCreation<SubmitOptions | undefined>({
        activeRuntimeKey,
        intent: newSessionDraft?.worktreeIntent,
        onReady: (continuation) => {
            void handleSubmitRef.current(continuation);
        },
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
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
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

    // Issue linking state
    const [issuePickerOpen, setIssuePickerOpen] = React.useState(false);
    const [prPickerOpen, setPrPickerOpen] = React.useState(false);
    const [linkedIssue, setLinkedIssue] = React.useState<{ 
        number: number; 
        title: string; 
        url: string; 
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);
    const [linkedPr, setLinkedPr] = React.useState<{
        number: number;
        title: string;
        url: string;
        head: string;
        base: string;
        includeDiff: boolean;
        instructionsText: string;
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);

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

    // Inline comment drafts
    const inlineDraftSessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
    const inlineDraftDirectory = currentSessionDirectoryForSync ?? currentDirectory;
    const inlineDraftTarget = React.useMemo<InlineCommentDraftTarget | null>(
        () => inlineDraftSessionKey && inlineDraftDirectory
            ? { directory: inlineDraftDirectory, sessionKey: inlineDraftSessionKey }
            : null,
        [inlineDraftDirectory, inlineDraftSessionKey],
    );
    const inlineDraftKey = inlineDraftTarget
        ? getInlineCommentDraftKey(activeRuntimeKey, inlineDraftTarget.directory, inlineDraftTarget.sessionKey)
        : null;
    const draftCount = useInlineCommentDraftStore(
        React.useCallback(
            (state) => inlineDraftKey ? (state.drafts[inlineDraftKey] ?? []).length : 0,
            [inlineDraftKey]
        )
    );
    const draftSourceKey = useInlineCommentDraftStore(
        React.useCallback(
            (state) => {
                const drafts = inlineDraftKey ? (state.drafts[inlineDraftKey] ?? []) : [];
                let previewConsole = 0;
                let previewAnnotation = 0;
                let review = 0;
                let terminal = 0;
                let prComment = 0;
                let prCheck = 0;
                for (const draft of drafts) {
                    if (draft.source === 'preview-console') previewConsole += 1;
                    else if (draft.source === 'preview-annotation') previewAnnotation += 1;
                    else if (draft.source === 'terminal') terminal += 1;
                    else if (draft.source === 'pr-comment') prComment += 1;
                    else if (draft.source === 'pr-check') prCheck += 1;
                    else review += 1;
                }
                return `${previewConsole}:${previewAnnotation}:${review}:${terminal}:${prComment}:${prCheck}`;
            },
            [inlineDraftKey]
        )
    );
    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);
    const removeInlineCommentDraft = useInlineCommentDraftStore((state) => state.removeDraft);
    const hasDrafts = draftCount > 0;
    const [previewConsoleCount, previewAnnotationCount, reviewCount, terminalContextCount, prCommentCount, prCheckCount] = draftSourceKey.split(':').map((entry) => Number(entry) || 0);
    const terminalContextDrafts = terminalContextCount > 0
        ? (inlineDraftKey ? useInlineCommentDraftStore.getState().drafts[inlineDraftKey] ?? [] : []).filter((draft) => draft.source === 'terminal')
        : [];
    const removePreviewDrafts = React.useCallback((source: 'preview-console' | 'preview-annotation' | 'pr-comment' | 'pr-check') => {
        if (!inlineDraftTarget) return;
        const drafts = useInlineCommentDraftStore.getState().getDrafts(inlineDraftTarget);
        for (const draft of drafts) {
            if (draft.source === source) {
                removeInlineCommentDraft(inlineDraftTarget, draft.id);
            }
        }
    }, [inlineDraftTarget, removeInlineCommentDraft]);
    // Review comments are the inline-comment drafts that aren't preview sources.
    const removeReviewDrafts = React.useCallback(() => {
        if (!inlineDraftTarget) return;
        const drafts = useInlineCommentDraftStore.getState().getDrafts(inlineDraftTarget);
        for (const draft of drafts) {
            if (draft.source !== 'preview-console' && draft.source !== 'preview-annotation' && draft.source !== 'terminal' && draft.source !== 'pr-comment' && draft.source !== 'pr-check') {
                removeInlineCommentDraft(inlineDraftTarget, draft.id);
            }
        }
    }, [inlineDraftTarget, removeInlineCommentDraft]);

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

    const hasContent = message.trim().length > 0 || attachedFiles.length > 0 || hasDrafts;
    const hasQueuedMessages = queuedMessages.length > 0;
    const hasUsableModel = Boolean(currentProviderId && currentModelId);
    const canSend = (hasContent || hasQueuedMessages) && hasUsableModel;

    const canAbort = sessionPhase !== 'idle';

    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? message;
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
        };
    }, [attachedFiles.length, hasDrafts, message]);

    // Add message to queue instead of sending
    const handleQueueMessage = React.useCallback(() => {
        const inputSnapshot = getCurrentInputSnapshot();
        if (!inputSnapshot.hasContent || !currentSessionId || !messageQueueTarget) return;

        const drafts = inlineDraftTarget ? consumeDrafts(inlineDraftTarget) : [];

        let messageToQueue = inputSnapshot.message.replace(/^\n+|\n+$/g, '');
        if (drafts.length > 0) {
            messageToQueue = appendInlineComments(messageToQueue, drafts);
        }
        const attachmentsToQueue = sanitizeAttachmentsForSend(attachedFiles);

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
        setMessage('');
        if (attachmentsToQueue.length > 0) {
            clearAttachedFiles();
        }

        if (!isMobile) {
            composerRef.current?.focus();
        }
    }, [getCurrentInputSnapshot, currentSessionId, messageQueueTarget, inlineDraftTarget, attachedFiles, sanitizeAttachmentsForSend, addToQueue, clearAttachedFiles, isMobile, consumeDrafts, currentProviderId, currentModelId, currentAgentName, currentVariant]);

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

    const openIssuePicker = React.useCallback(() => {
        setIssuePickerOpen(true);
    }, []);

    const openPrPicker = React.useCallback(() => {
        setPrPickerOpen(true);
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
        const inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
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
        if (worktreeIntent && !draftWorktreeCreation.getReceipt(worktreeIntent)) {
            await draftWorktreeCreation.request({
                intent: worktreeIntent,
                prompt: inputSnapshot.message,
                continuation: options,
            });
            return;
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
                handleQueueMessage();
                return;
            }
        }

        const branchCheckoutReceipt = draftBranchCheckout.getReceipt(branchIntent);
        const worktreeCreationReceipt = draftWorktreeCreation.getReceipt(worktreeIntent);
        const sendMessageOptions = capturedTarget
            ? { target: capturedTarget, ...(delivery ? { delivery } : {}) }
            : delivery || branchCheckoutReceipt || worktreeCreationReceipt
                ? {
                    ...(delivery ? { delivery } : {}),
                    ...(branchCheckoutReceipt ? { branchCheckoutReceipt } : {}),
                    ...(worktreeCreationReceipt ? { worktreeCreationReceipt } : {}),
                }
                : undefined;

        // Inline review comments and synthetic context are consumed before
        // assembly so a failed send can restore exactly what it took.
        const syntheticParts = consumePendingSyntheticParts();
        const consumedDraftTarget = queuedOnly ? null : inlineDraftTarget;
        const drafts: InlineCommentDraft[] = consumedDraftTarget
            ? consumeDrafts(consumedDraftTarget)
            : [];

        const availableSkillNames = new Set(
            useSkillsStore.getState().skills.map((skill) => skill.name),
        );

        const outgoing = buildOutgoingMessage({
            queued: queuedMessagesToSend,
            composerText: !queuedOnly && inputSnapshot.hasContent ? inputSnapshot.message : null,
            composerAttachments: attachedFiles,
            inlineComments: drafts,
            syntheticTexts: syntheticParts?.map((part) => part.text) ?? [],
            linkedIssueContext: linkedIssue?.contextText ?? null,
            linkedPr: linkedPr
                ? { instructions: linkedPr.instructionsText, context: linkedPr.contextText }
                : null,
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
            appendComments: (text, comments) =>
                appendInlineComments(text, comments as InlineCommentDraft[]),
            buildSkillInstruction: buildSkillMentionInstruction,
        });

        let primaryText = outgoing.primaryText;
        const { primaryAttachments, additionalParts, agentMentionName } = outgoing;

        if (outgoing.isEmpty) return;

        // Clear queue and input
        if (capturedTarget && queuedMessageId) {
            removeFromQueue(capturedTarget, queuedMessageId);
        } else if (capturedTarget && hasQueuedMessages) {
            clearQueue(capturedTarget);
        }
        if (!queuedOnly) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            // Clear per-session draft on submit
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            if (attachedFiles.length > 0) {
                clearAttachedFiles();
            }
            // Close expanded input overlay when submitting
            setExpandedInput(false);
        }

        if (isMobile) {
            composerRef.current?.blur();
        }

        // Local slash commands, normal mode only.
        const parsedCommand = inputMode === 'normal' ? parseSlashCommand(primaryText) : null;
        if (parsedCommand) {
            const { name: commandName, argument } = parsedCommand;

            // Commands that manipulate session state or open UI rather than
            // sending a message.
            if (commandName === 'undo' && currentSessionId) {
                await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                scrollToBottom?.();
                return;
            }
            if (commandName === 'redo' && currentSessionId) {
                await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                scrollToBottom?.();
                return;
            }
            if (commandName === 'timeline' && currentSessionId) {
                setTimelineDialogOpen(true);
                return;
            }
            if (commandName === 'compact') {
                if (!currentSessionId) {
                    toast.error('Open a session before compacting.');
                    return;
                }
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    await sessionActions.compactSession(currentSessionId, argument.trim() || undefined);
                } catch (error) {
                    toast.error(getSubmitErrorMessage(error, "Failed to compact session"));
                }
                return;
            }

            // The rest render a visible prompt plus synthetic instructions and
            // send them as one message.
            const command = findMagicPromptCommand(commandName);
            const commandIsAvailable = command !== null && canRunCommand(command, {
                hasSession: Boolean(currentSessionId),
                hasDraft: newSessionDraftOpen,
            });
            if (command && commandIsAvailable) {
                const variables = buildCommandVariables(command, argument);
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt(command.visiblePrompt, variables.visible);
                    const instructionsText = await renderMagicPrompt(command.instructionsPrompt, variables.instructions);
                    const commandSendPromise = sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    draftBranchCheckout.clearReceipt();
                    await commandSendPromise;
                    draftWorktreeCreation.clearReceipt();
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(getSubmitErrorMessage(error, command.errorToastKey));
                }
                return;
            }
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
        const restoreConsumedDrafts = () => {
            if (consumedDraftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(consumedDraftTarget, drafts);
            }
        };

        if (typeof window === 'undefined') {
            scrollToBottom?.();
        } else {
            window.requestAnimationFrame(() => {
                scrollToBottom?.();
            });
        }

        void sendPromise.then(() => {
            draftWorktreeCreation.clearReceipt();
            // Record what this session was pointed at. A snapshot only —
            // never re-fetched, never authoritative.
            // Failures are swallowed: the message went out, and a missing
            // bookkeeping entry must not surface as a send error.
            const attachedThread = linkedIssue
                ? { attachment: linkedIssue, kind: 'issue' as const }
                : linkedPr
                    ? { attachment: linkedPr, kind: 'pull' as const }
                    : null;
            // On a draft there is no session yet in this closure: the send path
            // creates one and makes it current before resolving, so the id is
            // read from the store. The fallback is used only when the closure
            // had no session at all, so a mid-send session switch cannot
            // redirect the write to an unrelated session.
            const sessionState = useSessionUIStore.getState();
            const linkTargetSessionId = currentSessionId ?? sessionState.currentSessionId;
            const linkTargetDirectory = currentSessionId
                ? currentSessionDirectoryForSync ?? currentDirectory
                : sessionState.currentSessionDirectory
                    ?? (linkTargetSessionId ? sessionState.getDirectoryForSession(linkTargetSessionId) : null)
                    ?? currentDirectory;

            if (attachedThread && linkTargetSessionId) {
                void sessionActions.setLinkedIssue(
                    linkTargetSessionId,
                    linkTargetDirectory,
                    buildLinkedIssue({
                        url: attachedThread.attachment.url,
                        number: attachedThread.attachment.number,
                        title: attachedThread.attachment.title,
                        kind: attachedThread.kind,
                        author: attachedThread.attachment.author,
                        linkedAt: Date.now(),
                    }),
                    true,
                ).catch(() => undefined);
            }

            // Clear linked issue after successful message send
            if (linkedIssue) {
                setLinkedIssue(null);
            }
            if (linkedPr) {
                setLinkedPr(null);
            }
        }).catch((error: unknown) => {
            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();

            console.error('Message send failed:', rawMessage || error);
            restoreConsumedDrafts();

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
                if (allAttachments.length > 0) {
                    useInputStore.getState().setAttachedFiles(allAttachments);
                }
                return;
            }

            if (isSoftNetworkError) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().setAttachedFiles(allAttachments);
                    toast.error("Failed to send attachments. Try fewer files or smaller images.");
                }
                return;
            }

            if (normalized.includes('runtime changed')) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().setAttachedFiles(allAttachments);
                }
                toast.error("Message failed to send. Attachments restored.");
                return;
            }

            if (allAttachments.length > 0) {
                useInputStore.getState().setAttachedFiles(allAttachments);
            }
            toast.error(rawMessage || "Message failed to send. Attachments restored.");
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
            handleQueueMessage();
        } else if (followUpBehavior === 'steer' && canQueue) {
            void handleSubmitRef.current({ delivery: 'steer' });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, sessionPhase, followUpBehavior, handleQueueMessage]);

    // Draft welcome presets: submit immediately.
    const submitPresetPrompt = React.useCallback((text: string, type: 'command' | 'skill') => {
        // The text goes straight into the submit (see SubmitOptions.presetText)
        // instead of through the composer input — the collapsed mobile pill has
        // no mounted textarea to stage it in.
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

    const handleKeyDown = (e: KeyboardEvent) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) return;

        if (inputMode === 'shell' && e.key === 'Escape') {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if (openAutocomplete === 'command' && commandRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                commandRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (openAutocomplete === 'skill' && skillRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                skillRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (openAutocomplete === 'snippet' && snippetRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                snippetRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (openAutocomplete === 'mention' && mentionRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                mentionRef.current.handleKeyDown(e.key);
                return;
            }
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = openAutocomplete !== null;
        const cursorAtStart = composerRef.current?.getSelection().start === 0 && composerRef.current?.getSelection().end === 0;
        const cursorAtEnd = composerRef.current?.getSelection().start === message.length && composerRef.current?.getSelection().end === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        // Markdown-aware auto-pairing (source mode), normal input only.
        if (inputMode === 'normal' && !isAnyAutocompleteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;

            if (ta && selStart >= 0) {
                const applyEdit = (next: string, caretStart: number, caretEnd: number) => {
                    e.preventDefault();
                    setMessage(next);
                    composerRef.current?.setSelection(caretStart, caretEnd);
                    updateAutocompleteState(next, caretEnd);
                };

                // Wrap the current selection: select text, press ` * _ ~ ( [ { " '
                const WRAP_PAIRS: Record<string, [string, string]> = {
                    '`': ['`', '`'], '*': ['*', '*'], '_': ['_', '_'], '~': ['~', '~'],
                    '(': ['(', ')'], '[': ['[', ']'], '{': ['{', '}'],
                    '"': ['"', '"'], "'": ["'", "'"],
                };
                if (selEnd > selStart && WRAP_PAIRS[e.key]) {
                    const [open, close] = WRAP_PAIRS[e.key];
                    const selected = message.slice(selStart, selEnd);
                    const next = `${message.slice(0, selStart)}${open}${selected}${close}${message.slice(selEnd)}`;
                    applyEdit(next, selStart + open.length, selEnd + open.length);
                    return;
                }

                // Typing the third backtick at line start expands into a fenced
                // code block with the caret on the empty middle line (Slack-like).
                if (e.key === '`' && selStart === selEnd) {
                    const before = message.slice(0, selStart);
                    if (/(^|\n)``$/.test(before)) {
                        const after = message.slice(selEnd);
                        const next = `${before}\`\n\n\`\`\`${after}`;
                        const caret = before.length + 2; // after the completed ``` and first newline
                        applyEdit(next, caret, caret);
                        return;
                    }
                }
            }
        }

        if (e.key === 'ArrowUp' && canNavigateHistoryUp) {
            e.preventDefault();
            const recalled = messageHistory.older(message);
            if (recalled !== null) {
                setMessage(recalled);
                // Caret to the start, so the recalled message reads from its
                // beginning rather than from wherever the draft's caret was.
                requestAnimationFrame(() => composerRef.current?.setSelection(0, 0));
            }
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown) {
            e.preventDefault();
            const recalled = messageHistory.newer();
            if (recalled !== null) setMessage(recalled);
            return;
        }

        // Handle Enter/Ctrl+Enter based on selected follow-up behavior.
        if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
            e.preventDefault();

            const isCtrlEnter = e.ctrlKey || e.metaKey;

            // Queueing / steering only works when there's an existing busy
            // session (or an active auto-review run).
            const canQueue = inputMode === 'normal' && hasContent && currentSessionId && sessionPhase !== 'idle';

            if (followUpBehavior === 'queue') {
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    handleQueueMessage();
                }
            } else {
                // steer: Enter steers into the running turn, Ctrl+Enter sends now.
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    handleSubmit({ delivery: 'steer' });
                }
            }
        }
    };

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

    const insertTextAtSelection = React.useCallback((
        text: string,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
    ) => {
        if (!text) {
            return;
        }

        const editor = composerRef.current;
        if (!editor) {
            // No mounted editor (collapsed mobile pill): append to the state
            // the editor will be seeded from.
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

    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        // Narrowed alias so the rest of the handler reads as it did when this
        // was a React synthetic event, whose clipboardData is never null.
        const e = { ...event, clipboardData, preventDefault: () => event.preventDefault() };

        // Pasting a URL over a selection wraps it as a markdown link:
        // [selected text](pasted url).
        if (inputMode === 'normal' && (currentSessionId || newSessionDraftOpen)) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;
            if (ta && selEnd > selStart) {
                const clipboardText = e.clipboardData.getData('text');
                const url = clipboardText.trim();
                const selected = message.slice(selStart, selEnd);
                if (shouldWrapSelectionAsLink(url, selected)) {
                    e.preventDefault();
                    const next = `${message.slice(0, selStart)}[${selected}](${url})${message.slice(selEnd)}`;
                    const caret = selStart + 1 + selected.length + 2 + url.length + 1;
                    setMessage(next);
                    composerRef.current?.setSelection(caret, caret);
                    updateAutocompleteState(next, caret, getFileMentionInputSourceForInsertedText(url), url);
                    return;
                }
            }
        }

        const fileMap = new Map<string, File>();

        Array.from(e.clipboardData.files || []).forEach(file => {
            if (file.type.startsWith('image/')) {
                fileMap.set(`${file.name}-${file.size}`, file);
            }
        });

        Array.from(e.clipboardData.items || []).forEach(item => {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    fileMap.set(`${file.name}-${file.size}`, file);
                }
            }
        });

        const imageFiles = Array.from(fileMap.values());
        const pastedText = e.clipboardData.getData('text');
        if (imageFiles.length === 0) {
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        if (!currentSessionId && !newSessionDraftOpen) {
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        e.preventDefault();

        const assignedFilenames = assignImageAttachmentFilenames(
            imageFiles,
            [
                ...attachedFiles.map((file) => file.filename),
                ...pendingPastedAttachmentFilenamesRef.current,
            ],
        );
        const citationText = buildAttachmentCitationText(assignedFilenames);
        const textarea = composerRef.current;
        const selectionStart = textarea?.getSelection().start ?? message.length;
        const selectionEnd = textarea?.getSelection().end ?? message.length;
        const insertionText = withInlineInsertionBoundaries(
            buildImagePasteInsertion(pastedText, citationText),
            message.slice(0, selectionStart),
            message.slice(selectionEnd),
        );

        insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));

        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedFilenames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            pendingPastedAttachmentFilenamesRef.current.add(filename);
            try {
                await addAttachedFile(file);
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : "Failed to attach image from clipboard");
            } finally {
                pendingPastedAttachmentFilenamesRef.current.delete(filename);
            }
        }
    }, [addAttachedFile, attachedFiles, currentSessionId, inputMode, markFileMentionPasteSuppression, message, newSessionDraftOpen, insertTextAtSelection, setMessage, updateAutocompleteState]);

    const handleFileSelect = (file: { name: string; path: string; relativePath?: string }) => {

        const cursorPosition = composerRef.current?.getSelection().start || 0;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toMentionPath(file.path) || file.name);

        confirmedMentionsRef.current.add(mentionPath);

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = lastAtSymbol + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (composerRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = cursorPosition + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleAgentSelect = (agentName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastAtSymbol + agentName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (composerRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = cursorPosition + agentName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleSkillSelect = (skillName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');

        if (lastSlashSymbol !== -1) {
            const newMessage =
                message.substring(0, lastSlashSymbol) +
                `/${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastSlashSymbol + skillName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleSnippetSelect = (_snippet: unknown, trigger: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
        const startIndex = lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition;
        const newMessage = `${message.substring(0, startIndex)}#${trigger} ${message.substring(cursorPosition)}`;
        setMessage(newMessage);
        const nextCursor = startIndex + trigger.length + 2;
        requestAnimationFrame(() => {
            if (composerRef.current) {
                composerRef.current.setSelection(nextCursor);
            }
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    };

    const handleCommandSelect = (command: CommandInfo) => {

        setMessage(`/${command.name} `);

        closeAutocomplete();

        const refocus = () => {
            if (composerRef.current) {
                try {
                    composerRef.current.focus({ preventScroll: true });
                } catch {
                    composerRef.current.focus();
                }
                composerRef.current.setSelection(composerRef.current.getValue().length, composerRef.current.getValue().length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    };

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

    // Mention paths are shown relative to the project the chat searches.
    const toMentionPath = React.useCallback(
        (absolutePath: string) => toProjectRelativeMentionPath(absolutePath, chatSearchDirectory || ""),
        [chatSearchDirectory],
    );

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current++;
        const isInternal = e.dataTransfer.types?.includes('application/x-pichamber-file-path') ?? false;
        if (isInternal !== isInternalDrag) {
            setIsInternalDrag(isInternal);
        }
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current--;
        if (dragEnterCountRef.current <= 0) {
            dragEnterCountRef.current = 0;
            setIsDragging(false);
            setIsInternalDrag(false);
        }
    };

    const handleDragEnd = () => {
        dragEnterCountRef.current = 0;
        setIsDragging(false);
        setIsInternalDrag(false);
    };

    const handleDrop = async (e: React.DragEvent) => {
        dragEnterCountRef.current = 0;
        const draggedFiles = hasDraggedFiles(e.dataTransfer);
        if (!draggedFiles) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

        // Internal drag: file tree → chat input (relative path as @mention)
        const internalPath = e.dataTransfer.getData('application/x-pichamber-file-path');
        if (internalPath && internalPath !== '.') {
            confirmedMentionsRef.current.add(internalPath);
            const mention = `@${internalPath}`;
            const textarea = composerRef.current;
            const currentMessage = messageRef.current;
            if (textarea) {
                const { start: pos, end } = textarea.getSelection();
                const before = currentMessage.slice(0, pos);
                const after = currentMessage.slice(end);
                const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
                const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
                const insert = `${needSpaceBefore ? ' ' : ''}${mention}${needSpaceAfter ? ' ' : ''}`;
                // Insert through the editor rather than setMessage: an editor
                // dispatch places the caret right after the mention, while the
                // external-rewrite path would send it to the end of the
                // message and pin the scroll to the bottom.
                textarea.replaceRange(pos, end, insert);
                cursorPosRef.current = pos + insert.length;
                textarea.focus();
            } else {
                setMessage((prev) => appendInlineText(prev, mention));
            }
            return;
        }

        const files = collectDroppedFiles(e.dataTransfer);

        if (files.length > 0) {
            let attached = false;
            for (const file of files) {
                try {
                    attached = (await addAttachedFile(file)) || attached;
                } catch (error) {
                    console.error('File attach failed', error);
                }
            }
            if (!attached) toast.error("Failed to attach file");
        }
    };

    const handleDropCapture = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        // Prevent native textarea drop text insertion for all runtimes
        e.preventDefault();
    };

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        const list = Array.isArray(files) ? files : Array.from(files);
        let attached = false;

        for (const file of list) {
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('File attach failed', error);
            }
        }
        if (list.length > 0 && !attached) {
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


    // Mobile pill composer: the collapse/expand state machine and the
    // platform corrections that keep it from fighting the soft keyboard.
    const mobileShell = useMobileComposerShell({
        isMobile,
        editorRef: composerRef,
        formRef: composerFormRef,
        setExpandedInput,
        // Dedicated mobile keeps the full composer up so model / variant
        // controls stay reachable. Tablets and hardware keyboards already
        // skip the pill for the same reason.
        alwaysExpanded: isMobile || hasHardwareKeyboard || isTabletLayout,
        holders: {
            controlsPanelOpen: Boolean(mobileControlsPanel),
            attachMenuOpen: mobileAttachMenuOpen,
            draftPickerOpen: mobileDraftPicker !== null,
            issuePickerOpen,
            prPickerOpen,
            isDragging,
        },
    });
    const mobileComposerExpanded = mobileShell.expanded;
    const mobileTextareaFocused = mobileShell.focused;


    const handleMobileNewSession = React.useCallback(() => {
        if (newSessionDraftOpen) return;
        openNewSessionDraft(currentDirectory ? { directoryOverride: currentDirectory } : undefined);
    }, [newSessionDraftOpen, openNewSessionDraft, currentDirectory]);



    const openMobileAttachSheet = React.useCallback(() => {
        // Mark the sheet open BEFORE the blur so the collapse watcher sees an
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
                <AttachedFilesList onShowPopup={handleShowAttachmentPreview} />
                <QueuedMessageChips
                    onEditMessage={handleQueuedMessageEdit}
                    onSendMessage={handleQueuedMessageSend}
                />
                {hasDrafts ? (
                    <ComposerContextChips
                        terminalDrafts={terminalContextDrafts}
                        reviewCount={reviewCount}
                        prCommentCount={prCommentCount}
                        prCheckCount={prCheckCount}
                        previewConsoleCount={previewConsoleCount}
                        previewAnnotationCount={previewAnnotationCount}
                        draftTarget={inlineDraftTarget}
                        onRemoveDraft={removeInlineCommentDraft}
                        onRemoveReviewDrafts={removeReviewDrafts}
                        onRemovePreviewDrafts={removePreviewDrafts}
                        colors={currentTheme.colors}
                    />
                ) : null}

                {linkedIssue ? (
                    <LinkedReferenceRow
                        numberLabel={`#${linkedIssue.number}`}
                        title={linkedIssue.title}
                        url={linkedIssue.url}
                        author={linkedIssue.author}
                        openInBrowserLabel={"Open issue in browser"}
                        removeLabel={"Remove linked issue"}
                        onReopenPicker={() => setIssuePickerOpen(true)}
                        onRemove={() => setLinkedIssue(null)}
                    />
                ) : null}
                {linkedPr ? (
                    <LinkedReferenceRow
                        numberLabel={`PR #${linkedPr.number}`}
                        title={linkedPr.title}
                        url={linkedPr.url}
                        author={linkedPr.author}
                        branches={{ head: linkedPr.head, base: linkedPr.base }}
                        openInBrowserLabel={"Open pull request in browser"}
                        removeLabel={"Remove linked pull request"}
                        onReopenPicker={() => setPrPickerOpen(true)}
                        onRemove={() => setLinkedPr(null)}
                    />
                ) : null}
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
                        <div className="min-w-0">
                            <p className="typography-ui-label">{draftWorktreeCreation.state.label}</p>
                            {draftWorktreeCreation.state.error ? (
                                <p className="mt-0.5 break-words">{draftWorktreeCreation.state.error}</p>
                            ) : null}
                        </div>
                    </div>
                ) : null}
                <div
                    className={cn(
                        !isMobile && 'contents',
                        isMobile && 'relative',
                        isMobileExpanded && 'flex min-h-0 flex-1 flex-col',
                    )}
                >
                {isMobile && !mobileComposerExpanded ? (
                    <MobilePillComposer
                        message={message}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        canAbort={canAbort}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        theme={currentTheme}
                        onExpand={mobileShell.expand}
                        onNewSession={handleMobileNewSession}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenIssuePicker={openIssuePicker}
                        onOpenPrPicker={openPrPicker}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onAbort={handleAbort}
                    />
                ) : (
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
                        canAbort={canAbort}
                        hasContent={Boolean(hasContent)}
                        onOpenSettings={onOpenSettings}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenIssuePicker={openIssuePicker}
                        onOpenPrPicker={openPrPicker}
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
                )}
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

        {/* Issue Picker Dialog */}
        <GitHubIssuePickerDialog
            open={issuePickerOpen}
            onOpenChange={setIssuePickerOpen}
            mode="select"
            onSelect={(issue) => {
                setLinkedIssue(issue);
                setLinkedPr(null);
            }}
        />
        <GitHubPrPickerDialog
            open={prPickerOpen}
            onOpenChange={setPrPickerOpen}
            onSelect={(pr) => {
                setLinkedPr(pr);
                setLinkedIssue(null);
            }}
        />
        {attachmentPreviewMounted ? (
            <React.Suspense fallback={null}>
                <ToolOutputDialog
                    popup={attachmentPreview}
                    onOpenChange={handleAttachmentPreviewOpenChange}
                    isMobile={isMobile}
                />
            </React.Suspense>
        ) : null}

        {/* Single always-mounted picker input. It must NOT live inside
            ComposerAttachmentControls: that component mounts once per composer
            variant (pill / expanded footer), so a shared ref got nulled when a
            variant unmounted, and a variant swap while the OS file picker was
            open detached the clicked input — its change event was silently
            lost and the picked files never attached. */}
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
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // Hand-off to the picker: don't sync-restore the
                            // keyboard under the overlay that opens next frame.
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openIssuePicker);
                        }}
                    >
                        <Icon name="github" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {"Link GitHub Issue"}
                    </button>
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openPrPicker);
                        }}
                    >
                        <Icon name="git-pull-request" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {"Link GitHub PR"}
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
