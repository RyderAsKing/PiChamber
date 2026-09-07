import React from 'react';

type OlderHistoryDemandOptions = {
    hasMoreBefore: boolean;
    beforeCursor?: string;
    resolveScrollContainer: () => HTMLDivElement | null;
    loadOlder: () => Promise<boolean>;
    onBeforeLoad: () => void;
    onLoadError: () => void;
};

const HISTORY_PREPEND_NEAR_TOP_VIEWPORTS = 1.5;

export const useOlderHistoryDemand = ({
    hasMoreBefore,
    beforeCursor,
    resolveScrollContainer,
    loadOlder,
    onBeforeLoad,
    onLoadError,
}: OlderHistoryDemandOptions): void => {
    React.useEffect(() => {
        if (!hasMoreBefore || !beforeCursor) return;
        const container = resolveScrollContainer();
        if (!container) return;
        let requested = false;
        let continuationTimer: number | undefined;
        let active = true;
        const requestIfNeeded = () => {
            if (requested || !hasMoreBefore) return;
            const nearTop = container.scrollTop < container.clientHeight * HISTORY_PREPEND_NEAR_TOP_VIEWPORTS;
            const underfilled = container.scrollHeight <= container.clientHeight + 1;
            if (!nearTop && !underfilled) return;
            requested = true;
            onBeforeLoad();
            void loadOlder().then((hasNextPage) => {
                if (!active) return;
                requested = false;
                if (hasNextPage) {
                    // Let React commit any newly visible rows first. If the page
                    // was entirely hidden by a turn gate, the unchanged top
                    // demand advances to the next cursor without requiring a
                    // scroll event that the browser cannot emit at scrollTop 0.
                    continuationTimer = window.setTimeout(requestIfNeeded, 0);
                }
            }).catch(() => {
                if (!active) return;
                requested = false;
                onLoadError();
            });
        };
        container.addEventListener('scroll', requestIfNeeded, { passive: true });
        requestIfNeeded();
        return () => {
            active = false;
            if (continuationTimer !== undefined) window.clearTimeout(continuationTimer);
            container.removeEventListener('scroll', requestIfNeeded);
        };
    }, [beforeCursor, hasMoreBefore, loadOlder, onBeforeLoad, onLoadError, resolveScrollContainer]);
};
