import React from 'react';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { ToolPart } from '@/lib/chat/types';
import type { PiExtensionDialogPayload } from '@/lib/pi/protocol';
import { markQuestionDrawn, sameToolQuestions, selectToolQuestions, toPluginQuestion } from '@/plugins/questions';
import { getTurnArtifact } from '@/plugins/registry';
import type { PluginQuestion } from '@/plugins/types';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import type { TurnRecord } from '../lib/turns/types';

interface TurnArtifact {
    id: string;
    part: ToolPart;
    Component: NonNullable<ReturnType<typeof getTurnArtifact>>;
}

const NO_QUESTIONS: PiExtensionDialogPayload[] = [];

/**
 * The questions this session's tool calls wait on, keyed by tool call id.
 * Read from the live session's pending dialogs on the `dialogs` topic, so
 * streaming text and tool updates do not re-render the artifacts.
 */
function useToolQuestions(sessionId: string | undefined): Map<string, PluginQuestion> {
    const dialogs = usePiSessionSnapshot(
        (state) => {
            const pending = sessionId ? state.reducer.bySession.get(sessionId)?.extensionDialogs : undefined;
            if (!pending || pending.length === 0) return NO_QUESTIONS;
            const questions = selectToolQuestions(pending);
            return questions.length === 0 ? NO_QUESTIONS : questions;
        },
        sameToolQuestions,
        'dialogs',
        sessionId ?? '',
    );
    return React.useMemo(() => {
        const byCall = new Map<string, PluginQuestion>();
        if (!sessionId) return byCall;
        for (const dialog of dialogs) {
            // The first question of a call is the one the dock shows too.
            if (dialog.toolCallId && !byCall.has(dialog.toolCallId)) {
                byCall.set(dialog.toolCallId, toPluginQuestion(sessionId, dialog));
            }
        }
        return byCall;
    }, [dialogs, sessionId]);
}

/** One artifact. While it is handed a question, the dock knows it is drawn here. */
function ArtifactItem({ artifact, directory, question }: {
    artifact: TurnArtifact;
    directory: string | null;
    question: PluginQuestion | undefined;
}) {
    const { part, Component } = artifact;
    const requestId = question?.requestId;
    React.useEffect(() => (requestId ? markQuestionDrawn(requestId) : undefined), [requestId]);
    return (
        <React.Suspense fallback={null}>
            <Component part={part} directory={directory} question={question} />
        </React.Suspense>
    );
}

/** Only mounted for a turn that has artifacts, so other turns skip the lookups. */
function ArtifactList({ artifacts, sessionId }: { artifacts: TurnArtifact[]; sessionId: string | undefined }) {
    const directory = useEffectiveDirectory() ?? null;
    const questions = useToolQuestions(sessionId);
    return (
        <div className="chat-message-column" data-turn-artifacts="true">
            {artifacts.map((artifact) => (
                <ArtifactItem
                    key={artifact.id}
                    artifact={artifact}
                    directory={directory}
                    question={artifact.part.callID ? questions.get(artifact.part.callID) : undefined}
                />
            ))}
        </div>
    );
}

/**
 * The `turn.artifacts` plugin slot: tool calls a native plugin draws (a
 * Visuals page, for example), between the activity rail and the reply. They
 * stay in view when the rail collapses. A call that waits on a question gets
 * it as `question`, and its component must offer every choice: the dock
 * above the composer folds to one line while the question is drawn here.
 */
const TurnPluginArtifacts: React.FC<{ turn: TurnRecord }> = ({ turn }) => {
    const artifacts = React.useMemo(() => turn.activityParts.flatMap((activity): TurnArtifact[] => {
        if (activity.kind !== 'tool' || activity.part.type !== 'tool') return [];
        const part = activity.part as ToolPart;
        const Component = getTurnArtifact(part.tool);
        return Component ? [{ id: activity.id, part, Component }] : [];
    }), [turn.activityParts]);

    if (artifacts.length === 0) return null;
    return <ArtifactList artifacts={artifacts} sessionId={turn.userMessage.info.sessionID} />;
};

export default React.memo(TurnPluginArtifacts);
