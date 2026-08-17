import React from 'react';

interface UseStreamingTextThrottleInput {
    text: string;
    isStreaming: boolean;
    throttleMs?: number;
    identityKey?: string;
    allowTextReplacement?: boolean;
}

export const getStreamingThrottleText = (
    current: string,
    next: string,
    isStreaming: boolean,
    allowTextReplacement: boolean,
): string => {
    return isStreaming && !allowTextReplacement && current.length > next.length ? current : next;
};

/**
 * Display the latest cadence-batched stream text.
 *
 * Token deltas already flush once per animation frame in `PiStreamCadence`.
 * Interpolating characters with another rAF loop here re-parsed markdown
 * several extra times per burst. Snap to the store text (with a monotonic
 * append guard so a shorter replacement cannot stutter) and let the
 * incremental markdown splitter own per-chunk work.
 */
export const useStreamingTextThrottle = ({
    text,
    isStreaming,
    identityKey,
    allowTextReplacement = false,
}: UseStreamingTextThrottleInput): string => {
    const identityRef = React.useRef(identityKey);
    const displayedRef = React.useRef(text);

    if (identityRef.current !== identityKey) {
        identityRef.current = identityKey;
        displayedRef.current = text;
        return text;
    }

    if (!isStreaming) {
        displayedRef.current = text;
        return text;
    }

    const next = getStreamingThrottleText(displayedRef.current, text, true, allowTextReplacement);
    displayedRef.current = next;
    return next;
};
