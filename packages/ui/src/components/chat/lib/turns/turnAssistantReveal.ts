type RevealListener = (messageId: string) => boolean;

/**
 * Small in-memory broker between MessageList's imperative navigation interface
 * and the mounted turn that owns deferred response state. Listeners unregister
 * on unmount, so session switches retain neither transcript data nor callbacks.
 */
const revealListenersByTurn = new Map<string, Set<RevealListener>>();

export const revealTurnAssistantMessage = (turnId: string, messageId: string): boolean => {
    const listeners = revealListenersByTurn.get(turnId);
    if (!listeners) return false;

    let handled = false;
    for (const listener of listeners) {
        handled = listener(messageId) || handled;
    }
    return handled;
};

export const subscribeToTurnAssistantRevealRequests = (
    turnId: string,
    listener: RevealListener,
): (() => void) => {
    const listeners = revealListenersByTurn.get(turnId) ?? new Set<RevealListener>();
    listeners.add(listener);
    revealListenersByTurn.set(turnId, listeners);

    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            revealListenersByTurn.delete(turnId);
        }
    };
};
