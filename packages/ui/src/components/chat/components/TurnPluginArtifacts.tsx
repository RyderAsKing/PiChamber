import React from 'react';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { ToolPart } from '@/lib/chat/types';
import { getTurnArtifact } from '@/plugins/registry';
import type { TurnRecord } from '../lib/turns/types';

interface TurnArtifact {
    id: string;
    part: ToolPart;
    Component: NonNullable<ReturnType<typeof getTurnArtifact>>;
}

/** Only mounted for a turn that has artifacts, so other turns skip the directory lookup. */
function ArtifactList({ artifacts }: { artifacts: TurnArtifact[] }) {
    const directory = useEffectiveDirectory() ?? null;
    return (
        <div className="chat-message-column" data-turn-artifacts="true">
            {artifacts.map(({ id, part, Component }) => (
                <React.Suspense key={id} fallback={null}>
                    <Component part={part} directory={directory} />
                </React.Suspense>
            ))}
        </div>
    );
}

/**
 * The `turn.artifacts` plugin slot: tool calls a native plugin draws (a
 * Visuals page, for example), between the activity rail and the reply. They
 * stay in view when the rail collapses.
 */
const TurnPluginArtifacts: React.FC<{ turn: TurnRecord }> = ({ turn }) => {
    const artifacts = React.useMemo(() => turn.activityParts.flatMap((activity): TurnArtifact[] => {
        if (activity.kind !== 'tool' || activity.part.type !== 'tool') return [];
        const part = activity.part as ToolPart;
        const Component = getTurnArtifact(part.tool);
        return Component ? [{ id: activity.id, part, Component }] : [];
    }), [turn.activityParts]);

    return artifacts.length === 0 ? null : <ArtifactList artifacts={artifacts} />;
};

export default React.memo(TurnPluginArtifacts);
