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

export const useStreamingTextThrottle = ({
    text,
    isStreaming,
    identityKey,
    allowTextReplacement = false,
}: UseStreamingTextThrottleInput): string => {
    const [displayedText, setDisplayedText] = React.useState(text);
    const targetTextRef = React.useRef(text);
    const displayedTextRef = React.useRef(displayedText);
    const rafIdRef = React.useRef<number | null>(null);

    targetTextRef.current = text;
    displayedTextRef.current = displayedText;

    // Reset immediately when identity changes
    React.useEffect(() => {
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        setDisplayedText(targetTextRef.current);
    }, [identityKey]);

    React.useEffect(() => {
        // If not streaming, snap immediately to full text
        if (!isStreaming) {
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
            }
            setDisplayedText(text);
            return;
        }

        if (allowTextReplacement && text.length < displayedTextRef.current.length) {
            setDisplayedText(text);
            return;
        }

        // Progressive animation loop to smoothly catch up to targetText frame by frame
        const step = () => {
            const current = displayedTextRef.current;
            const target = targetTextRef.current;

            if (current === target) {
                rafIdRef.current = null;
                return;
            }

            if (target.length < current.length) {
                if (allowTextReplacement) {
                    setDisplayedText(target);
                }
                rafIdRef.current = null;
                return;
            }

            // Adaptive step calculation:
            // For small distances (1-5 chars), advance 1-2 chars per frame for a silky smooth reveal.
            // For larger bursts (30+ chars), scale gracefully to catch up in a few frames without lag.
            const distance = target.length - current.length;
            const charsToAdvance = Math.max(1, Math.min(distance, Math.ceil(distance / 4)));
            const nextLength = current.length + charsToAdvance;
            const nextText = target.slice(0, nextLength);

            setDisplayedText(nextText);

            if (nextLength < target.length) {
                rafIdRef.current = requestAnimationFrame(step);
            } else {
                rafIdRef.current = null;
            }
        };

        if (rafIdRef.current === null && displayedTextRef.current !== text) {
            rafIdRef.current = requestAnimationFrame(step);
        }

        return () => {
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
            }
        };
    }, [text, isStreaming, allowTextReplacement]);

    return displayedText;
};
