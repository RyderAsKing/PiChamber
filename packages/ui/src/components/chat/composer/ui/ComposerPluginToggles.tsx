import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { piClient } from '@/lib/pi/client';
import type { PiComposerControl } from '@/lib/pi/protocol';
import { getTabClientId } from '@/lib/pi/tab-client-id';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { listComposerToggles, type ComposerToggleItem } from '@/plugins/composerToggles';
import {
    controlAccessibleName,
    controlHintText,
    controlPillText,
    controlSettled,
    nextControlValue,
    sameControls,
    shownControlValue,
    type ControlValue,
} from '@/plugins/extensionControls';
import { pickDraftControl } from '@/plugins/draftRuntime';
import { resolveExtensionControlIcon, resolvePluginIcon } from '@/plugins/icons';
import { rememberControls } from '@/plugins/rememberedControls';
import { selectComposerOverrides, selectComposerOverridesKnown, usePluginSessionStore, type ComposerTarget } from '@/plugins/sessionStore';
import { useDraftComposerControls } from '@/plugins/useDraftRuntime';
import { usePlugins } from '@/plugins/usePlugins';
import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';

interface ComposerPluginTogglesProps {
    directory?: string | null;
    /** What a switch changes: the open session or the new-session draft. */
    target: ComposerTarget;
    isMobile: boolean;
    className?: string;
    /** Phones: the footer's icon button and icon classes, so the button matches Attach. */
    iconButtonClassName?: string;
    iconClassName?: string;
}

interface ComposerToggle extends ComposerToggleItem {
    busy: boolean;
}

/** No border: on is the chip's tinted fill and primary text, off is plain text. */
const PILL_ON = cn(
    'bg-[color-mix(in_srgb,var(--primary-base)_10%,var(--background))] text-[var(--primary-base)]',
    'hover:bg-[color-mix(in_srgb,var(--primary-base)_16%,var(--background))]',
    'dark:bg-[color-mix(in_srgb,var(--primary-base)_16%,transparent)]',
    'dark:hover:bg-[color-mix(in_srgb,var(--primary-base)_22%,transparent)]',
);
/** Off is dimmer than the muted controls beside it; the fill shows on hover only. */
const PILL_OFF = 'bg-transparent text-subtle-foreground hover:bg-interactive-hover hover:text-muted-foreground';
/** A cycle or action has no off state: it reads like the footer's model and thinking controls. */
const PILL_NEUTRAL = 'bg-transparent text-muted-foreground hover:bg-interactive-hover hover:text-foreground';
const PILL_BASE = cn(
    'flex min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-full transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
);

/** Loads the session's own values and refreshes them when the window comes back into view. */
function useSessionOverridesLoader(sessionId: string | null) {
    const load = usePluginSessionStore((state) => state.load);
    React.useEffect(() => {
        if (!sessionId) return;
        void load(sessionId);
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        const refresh = () => {
            if (document.visibilityState !== 'hidden') void load(sessionId);
        };
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
        return () => {
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('focus', refresh);
        };
    }, [load, sessionId]);
}

/**
 * The toggles enabled plugins declare, as this session (or draft) has them,
 * and a way to flip one. A flip changes only the target; other sessions
 * they are.
 */
function useComposerToggles(directory: string | null | undefined, target: ComposerTarget) {
    const { plugins } = usePlugins(directory);
    // `target` is a fresh object each render; its kind and id are its identity.
    const targetKind = target.kind;
    const targetId = target.kind === 'session' ? target.sessionId : target.kind === 'draft' ? target.draftId : '';
    const stableTarget = React.useMemo<ComposerTarget>(() => {
        if (targetKind === 'session') return { kind: 'session', sessionId: targetId };
        if (targetKind === 'draft') return { kind: 'draft', draftId: targetId };
        return { kind: 'none' };
    }, [targetId, targetKind]);
    useSessionOverridesLoader(stableTarget.kind === 'session' ? stableTarget.sessionId : null);
    const overrides = usePluginSessionStore(React.useMemo(() => selectComposerOverrides(stableTarget), [stableTarget]));
    // Until a session's overrides are read (also after a failed read, which
    // focus retries), the switches show defaults and take no clicks.
    const known = usePluginSessionStore(React.useMemo(() => selectComposerOverridesKnown(stableTarget), [stableTarget]));
    const pending = usePluginSessionStore((state) => state.pending);
    const setForSession = usePluginSessionStore((state) => state.set);
    const setForDraft = usePluginSessionStore((state) => state.setDraft);

    const toggles = React.useMemo<ComposerToggle[]>(() => {
        if (stableTarget.kind === 'none') return [];
        return listComposerToggles(plugins, overrides).map((item) => ({
            ...item,
            busy: !known || (stableTarget.kind === 'session'
                && pending[`${stableTarget.sessionId}\n${item.plugin.id}\n${item.toggle.state}`] === true),
        }));
    }, [plugins, overrides, known, pending, stableTarget]);

    const flip = React.useCallback(({ plugin, toggle, on, defaultOn, busy }: ComposerToggle) => {
        // A flip already on its way: ignore the tap rather than report it as failed.
        if (busy) return;
        if (stableTarget.kind === 'draft') {
            setForDraft(stableTarget.draftId, plugin.id, toggle.state, !on, defaultOn);
            return;
        }
        if (stableTarget.kind !== 'session') return;
        void setForSession(stableTarget.sessionId, plugin.id, toggle.state, !on, defaultOn).then((ok) => {
            if (!ok) toast.error(`Could not turn ${toggle.label} ${on ? 'off' : 'on'} for this session`);
        });
    }, [setForDraft, setForSession, stableTarget]);

    return { toggles, flip };
}

const NO_CONTROLS: PiComposerControl[] = [];
/** How long a click's value is shown before the extension must have confirmed it. */
const PENDING_MS = 8000;

interface ExtensionControlItem {
    control: PiComposerControl;
    /** The value to draw: the clicked one while it lands, else the extension's. */
    shown: ControlValue;
    busy: boolean;
}

/**
 * Controls the session's Pi extensions declared (`pichamber.composer`), and a
 * way to click one.
 */
function useSessionExtensionControls(sessionId: string | null, directory: string | null | undefined) {
    const controls = usePiSessionSnapshot(
        (state) => {
            if (!sessionId) return NO_CONTROLS;
            const map = state.reducer.bySession.get(sessionId)?.extensionControls;
            return map?.size ? [...map.values()] : NO_CONTROLS;
        },
        sameControls,
        sessionId ? `session:${sessionId}` : 'chrome',
        sessionId ?? '',
    );
    // id → the value a click asked for (`undefined` for an action), while it lands.
    const [pending, setPending] = React.useState<ReadonlyMap<string, ControlValue>>(() => new Map());
    const pendingRef = React.useRef(pending);
    pendingRef.current = pending;

    const drop = React.useCallback((id: string) => {
        setPending((current) => {
            if (!current.has(id)) return current;
            const next = new Map(current);
            next.delete(id);
            return next;
        });
    }, []);

    // A new session starts with nothing on its way.
    React.useEffect(() => {
        setPending(new Map());
    }, [sessionId]);

    // The extension's value caught up (or the control is gone): stop showing the click's.
    React.useEffect(() => {
        if (pending.size === 0) return;
        for (const [id, value] of pending) {
            const control = controls.find((candidate) => candidate.id === id);
            if (control?.kind === 'action') continue;
            if (controlSettled(control, value)) drop(id);
        }
    }, [controls, drop, pending]);

    /** Asks for `choice.value` (a cycle option picked in the sheet), or else the next value. */
    const run = React.useCallback((control: PiComposerControl, choice?: { value: ControlValue }) => {
        if (!sessionId || pendingRef.current.has(control.id)) return;
        const value = choice ? choice.value : nextControlValue(control, shownControlValue(control, undefined));
        if (control.kind !== 'action' && value === control.value) return;
        setPending((current) => new Map(current).set(control.id, value));
        const timer = setTimeout(() => drop(control.id), PENDING_MS);
        void piClient.runExtensionControl(
            { sessionId, id: control.id, ...(value !== undefined ? { value } : {}), clientId: getTabClientId() },
            { ...(directory ? { directory } : {}), runtimeKey: getRuntimeKey() },
        ).then(({ ran }) => {
            // Nothing ran (the value was already set, or the control went away):
            // there is no event to wait for. An action is done once it answers.
            if (!ran || control.kind === 'action') {
                clearTimeout(timer);
                drop(control.id);
            }
        }, () => {
            clearTimeout(timer);
            drop(control.id);
            toast.error(control.kind === 'action' ? `Could not run ${control.label}` : `Could not change ${control.label}`);
        });
    }, [directory, drop, sessionId]);

    // What this folder's extensions declare, for the next draft here to show while it starts.
    React.useEffect(() => {
        if (sessionId) rememberControls(getRuntimeKey(), directory, controls, { authoritative: false });
    }, [controls, directory, sessionId]);

    const items = React.useMemo<ExtensionControlItem[]>(() => controls.map((control) => ({
        control,
        shown: shownControlValue(control, pending.get(control.id)),
        busy: pending.has(control.id),
    })), [controls, pending]);

    return { controls: items, run };
}

/**
 * A new-session draft's controls: its draft session's once that has started,
 * the folder's remembered ones before. A click before the draft session is
 * ready shows its value and waits; an action needs the draft session.
 */
function useDraftExtensionControls(draftId: string | null) {
    const { controls, status, picks } = useDraftComposerControls(draftId);
    const ready = status === 'ready';

    const items = React.useMemo<ExtensionControlItem[]>(() => controls.map((control) => {
        const pick = picks[control.id];
        return {
            control,
            shown: shownControlValue(control, pick?.value),
            busy: Boolean(pick?.sentAt) || (control.kind === 'action' && !ready),
        };
    }), [controls, picks, ready]);

    const run = React.useCallback((control: PiComposerControl, choice?: { value: ControlValue }) => {
        if (!draftId || (control.kind === 'action' && !ready)) return;
        const value = choice ? choice.value : nextControlValue(control, shownControlValue(control, picks[control.id]?.value));
        pickDraftControl(draftId, control, value);
    }, [draftId, picks, ready]);

    return { controls: items, run };
}

/** The open session's controls, or the draft's. */
function useExtensionControls(target: ComposerTarget, directory: string | null | undefined) {
    const session = useSessionExtensionControls(target.kind === 'session' ? target.sessionId : null, directory);
    const draft = useDraftExtensionControls(target.kind === 'draft' ? target.draftId : null);
    return target.kind === 'draft' ? draft : session;
}

/** Tooltip and sheet copy: what this session uses, and the default when they differ. */
const sessionStateText = ({ on, defaultOn }: ComposerToggle): string => {
    const here = on ? 'On for this session' : 'Off for this session';
    return on === defaultOn ? here : `${here}, ${defaultOn ? 'on' : 'off'} by default`;
};

/**
 * Desktop toggles show their labels while they fit and drop to icons (the
 * label stays in the tooltip and the accessible name) when the footer is
 * narrow, for example beside an open panel. `fullWidth` remembers how wide
 * the labelled row was, so labels come back only once that much room is
 * free again.
 */
function useCompactWhenNarrow(enabled: boolean, resetKey: string) {
    const outerRef = React.useRef<HTMLDivElement>(null);
    const innerRef = React.useRef<HTMLDivElement>(null);
    const [compact, setCompact] = React.useState(false);
    const compactRef = React.useRef(false);
    const fullWidthRef = React.useRef(0);

    React.useLayoutEffect(() => {
        compactRef.current = false;
        setCompact(false);
        const outer = outerRef.current;
        const inner = innerRef.current;
        if (!enabled || !outer || !inner || typeof ResizeObserver !== 'function') return;
        const measure = () => {
            const available = outer.clientWidth;
            if (!compactRef.current) {
                fullWidthRef.current = inner.offsetWidth;
                if (fullWidthRef.current > available + 1) {
                    compactRef.current = true;
                    setCompact(true);
                }
            } else if (available >= fullWidthRef.current) {
                compactRef.current = false;
                setCompact(false);
            }
        };
        const observer = new ResizeObserver(measure);
        observer.observe(outer);
        observer.observe(inner);
        measure();
        return () => observer.disconnect();
    }, [enabled, resetKey]);

    return { outerRef, innerRef, compact };
}

/** One desktop pill for an extension's control. */
function ExtensionControlPill({ item, compact, onRun }: { item: ExtensionControlItem; compact: boolean; onRun: () => void }) {
    const { control, shown, busy } = item;
    const on = control.kind === 'toggle' && shown === true;
    const icon = resolveExtensionControlIcon(control.icon, on);
    // Without an icon there is nothing to shrink to, so the label stays.
    const iconOnly = compact && icon !== null;
    const hint = controlHintText(control, shown);
    return (
        <Tooltip delayDuration={600}>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    aria-pressed={control.kind === 'toggle' ? on : undefined}
                    aria-label={controlAccessibleName(control, shown)}
                    aria-disabled={busy || undefined}
                    onClick={onRun}
                    className={cn(
                        PILL_BASE,
                        iconOnly ? 'size-6' : 'h-6 px-2',
                        control.kind === 'toggle' ? (on ? PILL_ON : PILL_OFF) : PILL_NEUTRAL,
                    )}
                    data-extension-control={control.id}
                >
                    {icon ? <Icon name={icon} className="size-3.5 shrink-0" /> : null}
                    {iconOnly ? null : (
                        <span className="typography-meta whitespace-nowrap font-normal">{controlPillText(control, shown)}</span>
                    )}
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="center">
                <span className="block typography-meta">{control.description ?? controlAccessibleName(control, shown)}</span>
                {hint ? <span className="block typography-meta text-muted-foreground">{hint}</span> : null}
            </TooltipContent>
        </Tooltip>
    );
}

function DesktopToggles({ directory, target, className }: Pick<ComposerPluginTogglesProps, 'directory' | 'target' | 'className'>) {
    const { toggles, flip } = useComposerToggles(directory, target);
    const { controls, run } = useExtensionControls(target, directory);
    const toggleKey = [
        ...toggles.map(({ plugin, toggle }) => `${plugin.id}:${toggle.id}`),
        ...controls.map(({ control }) => `ext:${control.id}`),
    ].join(',');
    const count = toggles.length + controls.length;
    const { outerRef, innerRef, compact } = useCompactWhenNarrow(count > 0, toggleKey);

    if (count === 0) return null;

    return (
        <div
            ref={outerRef}
            // Takes the footer's free space, so it can tell when the labels no longer fit.
            className={cn('ml-1.5 flex min-w-0 flex-1 overflow-x-clip', className)}
            data-composer-plugin-toggles="true"
        >
            <div
                ref={innerRef}
                // An off pill shows no edge, only its label, so spacing is set
                // between labels: the footer's gap and `ml-1.5` before the
                // first, then each pill's 8px padding on both sides plus
                // `gap-x-1`, about as far apart as model and thinking.
                className="flex w-max shrink-0 items-center gap-x-1"
            >
                {toggles.map((item) => {
                    const { plugin, toggle, on, busy } = item;
                    return (
                        <Tooltip key={`${plugin.id}:${toggle.id}`} delayDuration={600}>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    aria-pressed={on}
                                    aria-label={toggle.label}
                                    // Stays focusable while its write lands, so keyboard focus is kept.
                                    aria-disabled={busy || undefined}
                                    onClick={() => flip(item)}
                                    className={cn(PILL_BASE, compact ? 'size-6' : 'h-6 px-2', on ? PILL_ON : PILL_OFF)}
                                >
                                    <Icon name={resolvePluginIcon(toggle.icon, on)} className="size-3.5 shrink-0" />
                                    {compact ? null : (
                                        <span className="typography-meta whitespace-nowrap font-normal">{toggle.label}</span>
                                    )}
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" align="center">
                                <span className="block typography-meta">{toggle.description ?? toggle.label}</span>
                                <span className="block typography-meta text-muted-foreground">{sessionStateText(item)}</span>
                            </TooltipContent>
                        </Tooltip>
                    );
                })}
                {controls.map((item) => (
                    <ExtensionControlPill key={`ext:${item.control.id}`} item={item} compact={compact} onRun={() => run(item.control)} />
                ))}
            </div>
        </div>
    );
}

/** One sheet row for an extension's control: a switch, a row of options, or a Run button. Text only, like the plugin rows, so every row starts at the same edge. */
function ExtensionControlRow({ item, onRun }: { item: ExtensionControlItem; onRun: (choice?: { value: ControlValue }) => void }) {
    const { control, shown, busy } = item;
    const on = control.kind === 'toggle' && shown === true;
    const text = (
        <span className="min-w-0 flex-1">
            <span className="block typography-ui-label font-medium text-foreground">{control.label}</span>
            {control.description ? (
                <span className="mt-0.5 block text-pretty typography-meta text-muted-foreground">{control.description}</span>
            ) : null}
        </span>
    );

    if (control.kind === 'toggle') {
        return (
            <label className="flex min-w-0 cursor-pointer items-center gap-3 px-4 py-3.5">
                {text}
                <Switch checked={on} disabled={busy} ariaLabel={control.label} onChange={() => onRun({ value: !on })} />
            </label>
        );
    }
    if (control.kind === 'action') {
        return (
            <div className="flex min-w-0 items-center gap-3 px-4 py-3.5">
                {text}
                <Button variant="outline" size="sm" disabled={busy} aria-label={`Run ${control.label}`} onClick={() => onRun()}>
                    {'Run'}
                </Button>
            </div>
        );
    }
    return (
        <div className="min-w-0 px-4 py-3.5">
            {text}
            <div role="group" aria-label={control.label} className="mt-2.5 flex flex-wrap gap-1.5">
                {control.options.map((option) => (
                    <Button
                        key={option.value}
                        variant="chip"
                        size="sm"
                        aria-pressed={shown === option.value}
                        aria-disabled={busy || undefined}
                        onClick={() => onRun({ value: option.value })}
                    >
                        {option.label}
                    </Button>
                ))}
            </div>
        </div>
    );
}

/**
 * Phones: one sliders button beside Send, styled like the footer's other icon
 * buttons, that opens a sheet with a switch per toggle. It looks the same
 * whatever is on; the sheet shows the state. The footer strip has no room for
 * a pill per toggle, and touch has no tooltips to explain bare icons.
 */
function MobileToggles({
    directory,
    target,
    className,
    iconButtonClassName,
    iconClassName,
}: Omit<ComposerPluginTogglesProps, 'isMobile'>) {
    const { toggles, flip } = useComposerToggles(directory, target);
    const { controls, run } = useExtensionControls(target, directory);
    const mobileActions = useMobileAppActions();
    const [open, setOpen] = React.useState(false);

    if (toggles.length === 0 && controls.length === 0) return null;

    const summary = [
        ...toggles.map(({ toggle, on }) => `${toggle.label} ${on ? 'on' : 'off'}`),
        ...controls.map(({ control, shown }) => (
            control.kind === 'toggle' ? `${control.label} ${shown === true ? 'on' : 'off'}` : controlAccessibleName(control, shown)
        )),
    ].join(', ');
    // The button looks the same whatever is on, except for a dot while this
    // session differs from the defaults, so a changed session is noticed.
    const changed = toggles.some(({ on, defaultOn }) => on !== defaultOn);
    const openSettings = () => {
        setOpen(false);
        useUIStore.getState().setSettingsPage('plugins');
        if (mobileActions) mobileActions.openSettings('plugins');
        else useUIStore.getState().setSettingsDialogOpen(true);
    };

    return (
        <>
            <button
                type="button"
                aria-label={`Composer controls: ${summary}${changed ? ', changed for this session' : ''}`}
                aria-haspopup="dialog"
                onClick={() => setOpen(true)}
                // Like Attach: keep the tap from dismissing the keyboard, whose
                // relayout on Android can move the button mid-tap.
                onMouseDown={(event) => event.preventDefault()}
                onPointerDownCapture={(event) => {
                    if (event.pointerType === 'touch') event.preventDefault();
                }}
                className={cn(iconButtonClassName, 'relative', className)}
                data-composer-plugin-toggles="true"
            >
                <Icon name="equalizer" className={cn(iconClassName ?? 'size-4', 'text-current')} />
                {changed ? (
                    <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--primary-base)]" />
                ) : null}
            </button>
            <MobileOverlayPanel
                open={open}
                title="Composer controls"
                onClose={() => setOpen(false)}
                footer={toggles.length > 0 ? (
                    <Button variant="ghost" size="sm" className="w-full justify-center" onClick={openSettings}>
                        {'Plugin settings'}
                    </Button>
                ) : undefined}
            >
                {toggles.length > 0 ? (
                    <p className="px-4 pt-3 pb-1 text-pretty typography-meta text-muted-foreground">
                        {'These switches change this session only. New sessions start with their defaults.'}
                    </p>
                ) : null}
                <ul className="divide-y divide-border/60">
                    {toggles.map((item) => {
                        const { plugin, toggle, on, defaultOn, busy } = item;
                        return (
                            <li key={`${plugin.id}:${toggle.id}`}>
                                <label className="flex min-w-0 cursor-pointer items-center gap-3 px-4 py-3.5">
                                    <span className="min-w-0 flex-1">
                                        <span className="block typography-ui-label font-medium text-foreground">{toggle.label}</span>
                                        {toggle.description ? (
                                            <span className="mt-0.5 block text-pretty typography-meta text-muted-foreground">{toggle.description}</span>
                                        ) : null}
                                        {on !== defaultOn ? (
                                            <span className="mt-0.5 block typography-meta text-muted-foreground">
                                                {defaultOn ? 'On by default' : 'Off by default'}
                                            </span>
                                        ) : null}
                                    </span>
                                    <Switch checked={on} disabled={busy} ariaLabel={toggle.label} onChange={() => flip(item)} />
                                </label>
                            </li>
                        );
                    })}
                </ul>
                {controls.length > 0 ? (
                    <>
                        <p className="px-4 pt-4 pb-1 text-pretty typography-meta text-muted-foreground">
                            {'From your Pi extensions. Each runs the extension\'s own command.'}
                        </p>
                        <ul className="divide-y divide-border/60">
                            {controls.map((item) => (
                                <li key={`ext:${item.control.id}`}>
                                    <ExtensionControlRow item={item} onRun={(choice) => run(item.control, choice)} />
                                </li>
                            ))}
                        </ul>
                    </>
                ) : null}
            </MobileOverlayPanel>
        </>
    );
}

/**
 * The `composer.toggles` plugin slot: one switch per toggle an enabled plugin
 * declares, bound to a boolean state value, followed by the controls the
 * session's Pi extensions declare (`pichamber.composer`). Drawn by the host so
 * every one looks and behaves the same: a pill each on desktop, one button and
 * a sheet on phones.
 */
export function ComposerPluginToggles({ isMobile, ...props }: ComposerPluginTogglesProps) {
    return isMobile
        ? <MobileToggles {...props} />
        : <DesktopToggles directory={props.directory} target={props.target} className={props.className} />;
}
