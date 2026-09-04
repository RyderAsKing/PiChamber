import React from 'react';
import { cn } from '@/lib/utils';

const MAX_BUSY_DURATION_MS = 5 * 60 * 1000; // 5 minutes cap

interface MinDurationShineTextProps {
    active: boolean;
    minDurationMs?: number;
    className?: string;
    children: React.ReactNode;
    style?: React.CSSProperties;
    title?: string;
}

export const MinDurationShineText: React.FC<MinDurationShineTextProps> = ({
    active,
    minDurationMs = 300,
    className,
    children,
    style,
    title,
}) => {
    const busyStartRef = React.useRef<number | null>(active ? Date.now() : null);
    const [isBusy, setIsBusy] = React.useState(active);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    if (active && busyStartRef.current === null) {
        busyStartRef.current = Date.now();
    }

    React.useEffect(() => {
        if (active) {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (busyStartRef.current === null) {
                busyStartRef.current = Date.now();
            }

            const elapsed = Date.now() - busyStartRef.current;
            if (elapsed >= MAX_BUSY_DURATION_MS) {
                setIsBusy(false);
                busyStartRef.current = null;
                return;
            }

            setIsBusy(true);
            return;
        }

        if (!isBusy) {
            busyStartRef.current = null;
            return;
        }

        const startedAt = busyStartRef.current ?? Date.now();
        const elapsed = Date.now() - startedAt;

        if (elapsed >= MAX_BUSY_DURATION_MS) {
            setIsBusy(false);
            busyStartRef.current = null;
            return;
        }

        const remaining = Math.max(0, minDurationMs - elapsed);

        timerRef.current = setTimeout(() => {
            setIsBusy(false);
            busyStartRef.current = null;
            timerRef.current = null;
        }, remaining);

        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [active, minDurationMs, isBusy]);

    // While busy the shimmer class owns the text fill (transparent +
    // background-clip:text gradient, same as the AgentThinkingLoader label).
    // The caller's inline title color is dropped so it cannot cover the
    // gradient — and so the reduced-motion static fallback stays visible.
    // Settled rows keep their inline dimmed color untouched.
    const busyStyle = React.useMemo(() => {
        if (!isBusy) {
            return style;
        }
        if (!style) {
            return undefined;
        }
        const rest = { ...style };
        delete rest.color;
        return rest;
    }, [isBusy, style]);

    return (
        <span
            // Running verbs shimmer exactly like the agent working label
            // (`oc-shimmer-verb`). Applied in render so the first paint
            // already carries it (no flash-visible frame); the busy cap
            // above bounds the infinite sweep like the single status line.
            className={cn('transition-opacity duration-200', isBusy && 'oc-shimmer-verb', className)}
            style={busyStyle}
            title={title}
        >
            {children}
        </span>
    );
};
