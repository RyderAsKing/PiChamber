/**
 * Mobile composer platform corrections.
 *
 * The full composer stays mounted on mobile. This hook owns only the browser /
 * WebView behavior needed around focus and overlay hand-offs: iOS refusing
 * programmatic focus outside a gesture, WebKit leaving the layout viewport
 * panned after the keyboard hides, and overlay chains handing off through a
 * frame where nothing is open.
 *
 * Every timeout and flushSync below marks one of those platform behaviors and
 * is verified on hardware rather than by DOM unit tests.
 */

import React from 'react';
import { flushSync } from 'react-dom';

import { observeEditorFocus } from '@/lib/hardwareKeyboard';
import { isCapacitorApp } from '@/lib/platform';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';

export interface MobileComposerShellOptions {
    isMobile: boolean;
    editorRef: React.RefObject<ComposerEditorHandle | null>;
    formRef: React.RefObject<HTMLFormElement | null>;
    controlsPanelOpen: boolean;
    attachMenuOpen: boolean;
}

export interface MobileComposerShell {
    /** The editor has focus; the best keyboard proxy a browser offers. */
    focused: boolean;
    onEditorFocus: () => void;
    onEditorBlur: () => void;
    /** Cancel a pending keyboard restore entirely (a native picker takes over). */
    cancelOverlayCloseRestore: () => void;
}

export function useMobileComposerShell(
    options: MobileComposerShellOptions,
): MobileComposerShell {
    const { isMobile, editorRef, formRef, controlsPanelOpen, attachMenuOpen } = options;

    const [focused, setFocused] = React.useState(false);
    const [overlayHostBusy, setOverlayHostBusy] = React.useState(false);
    const lastBlurAtRef = React.useRef(0);
    const restoreKeyboardRef = React.useRef(false);
    const blurTimerRef = React.useRef<number | null>(null);

    React.useEffect(() => () => {
        if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
    }, []);

    // Watch the shared overlay portal root: any mounted MobileOverlayPanel
    // counts as busy. Observing the host catches overlays whose open state
    // lives in other modules without threading that state through ChatInput.
    React.useEffect(() => {
        if (!isMobile || typeof document === 'undefined') return;
        let host = document.getElementById('mobile-overlay-root');
        if (!host) {
            host = document.createElement('div');
            host.id = 'mobile-overlay-root';
            document.body.appendChild(host);
        }
        const hostEl = host;
        const update = () => setOverlayHostBusy(hostEl.childElementCount > 0);
        update();
        const observer = new MutationObserver(update);
        observer.observe(hostEl, { childList: true });
        return () => observer.disconnect();
    }, [isMobile]);

    const overlayOpen = overlayHostBusy || controlsPanelOpen || attachMenuOpen;

    // Installed PWA (standalone): a focus() from a bare timeout is outside the
    // user gesture and iOS refuses to raise the keyboard for it. The overlay
    // close event fires in the same React flush as the closing click, so refocus
    // there while the gesture is still live.
    const openSheetCountRef = React.useRef(0);
    const holdFocusUntilRef = React.useRef(0);

    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof window === 'undefined') return;
        if (!window.matchMedia?.('(display-mode: standalone)')?.matches) return;

        const handleOverlayOpened = () => {
            openSheetCountRef.current += 1;
        };
        const handleOverlayClosed = () => {
            // Counter instead of a DOM check: the close event fires from a
            // layout-effect cleanup while the closing portal can still exist.
            openSheetCountRef.current = Math.max(0, openSheetCountRef.current - 1);
            if (!restoreKeyboardRef.current || openSheetCountRef.current > 0) return;
            restoreKeyboardRef.current = false;

            // iOS can dismiss the freshly-raised keyboard when the closing tap
            // settles over non-input content. Hold focus through that window.
            holdFocusUntilRef.current = Date.now() + 600;
            editorRef.current?.focus();
            if (editorRef.current?.isFocused()) setFocused(true);

            const reveal = () => {
                const editor = editorRef.current;
                if (!editor?.isFocused()) return;
                (formRef.current ?? editor.getScrollDOM())?.scrollIntoView({ block: 'end' });
            };
            window.setTimeout(reveal, 300);
            window.setTimeout(reveal, 650);
        };

        window.addEventListener('oc:mobile-overlay-opened', handleOverlayOpened);
        window.addEventListener('oc:mobile-overlay-closed', handleOverlayClosed);
        return () => {
            window.removeEventListener('oc:mobile-overlay-opened', handleOverlayOpened);
            window.removeEventListener('oc:mobile-overlay-closed', handleOverlayClosed);
        };
    }, [editorRef, formRef, isMobile]);

    // If the keyboard was open (or closed moments ago by the overlay's own
    // blur) when an overlay appeared, bring it back once every overlay is gone.
    React.useEffect(() => {
        if (!isMobile) return;
        if (overlayOpen) {
            if (focused || Date.now() - lastBlurAtRef.current < 800) {
                restoreKeyboardRef.current = true;
            }
            return;
        }
        if (!restoreKeyboardRef.current) return;
        // Overlay chains hand off with a frame of "nothing open" between steps.
        // Wait out that gap and cancel if another overlay appears.
        const timer = window.setTimeout(() => {
            restoreKeyboardRef.current = false;
            editorRef.current?.focus({ preventScroll: isCapacitorApp() });
        }, 180);
        return () => window.clearTimeout(timer);
    }, [editorRef, focused, isMobile, overlayOpen]);

    // Browser counterpart of Capacitor's native keyboard root class. The
    // focused composer is the best keyboard proxy a browser has.
    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof document === 'undefined') return;
        const root = document.documentElement;
        if (focused) {
            root.classList.add('oc-browser-keyboard-open');
        } else {
            root.classList.remove('oc-browser-keyboard-open');
            // Installed PWA: WebKit can leave the layout viewport panned after
            // keyboard dismissal. A zero scroll after the exit settles resets it.
            if (window.matchMedia?.('(display-mode: standalone)')?.matches) {
                window.setTimeout(() => {
                    if (root.classList.contains('oc-browser-keyboard-open')) return;
                    window.scrollTo(0, 0);
                    document.body.scrollTop = 0;
                    root.scrollTop = 0;
                }, 350);
            }
        }
        return () => root.classList.remove('oc-browser-keyboard-open');
    }, [focused, isMobile]);

    const onEditorFocus = React.useCallback(() => {
        if (!isMobile) return;
        if (isCapacitorApp()) observeEditorFocus();
        if (blurTimerRef.current !== null) {
            window.clearTimeout(blurTimerRef.current);
            blurTimerRef.current = null;
        }
        setFocused(true);
    }, [isMobile]);

    const onEditorBlur = React.useCallback(() => {
        if (!isMobile) return;

        // Focus hold after an overlay-close restore: iOS may retract the rising
        // keyboard as the closing tap settles, so take focus back immediately.
        if (Date.now() < holdFocusUntilRef.current) {
            const editor = editorRef.current;
            if (editor) {
                editor.focus();
                window.setTimeout(() => {
                    if (Date.now() < holdFocusUntilRef.current && !editor.isFocused()) {
                        editor.focus();
                    }
                }, 50);
                return;
            }
        }

        lastBlurAtRef.current = Date.now();

        // Browser/PWA blur can precede a button's synthesized click. Delay the
        // state transition so the keyboard-dismiss reflow cannot move the tap
        // target first. Capacitor does not need the delay, but synchronous state
        // keeps native keyboard/overlay events from observing stale focus.
        if (isCapacitorApp()) {
            flushSync(() => setFocused(false));
            return;
        }
        if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = window.setTimeout(() => {
            blurTimerRef.current = null;
            setFocused(false);
        }, 120);
    }, [editorRef, isMobile]);

    const cancelOverlayCloseRestore = React.useCallback(() => {
        restoreKeyboardRef.current = false;
    }, []);

    return {
        focused,
        onEditorFocus,
        onEditorBlur,
        cancelOverlayCloseRestore,
    };
}
