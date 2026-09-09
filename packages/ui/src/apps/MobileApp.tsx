import React from 'react';

import { MobileAppUpdateToast } from '@/components/update/MobileAppUpdateToast';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { PerfHudHost } from '@/components/perf/PerfHudHost';
import { WorktreeCreationToasts } from '@/components/worktree/WorktreeCreationToasts';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { DeferredUpdatePolling } from '@/hooks/useUpdatePolling';
import { WindowTitleEffect } from '@/hooks/useWindowTitle';
import { getPiSessionStore } from '@/apps/pi-session-store';
import type { RuntimeAPIs } from '@/lib/api/types';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { syncDesktopSettings } from '@/lib/persistence';
import { startMobileErrorLogCapture } from '@/lib/mobile-error-log';
import { refreshGlobalSessions, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { clearLastActiveSession, readLastActiveSession } from '@/sync/last-session-cache';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { PiSessionProvider } from '@/sync/pi-session-context';
import { FireworksProvider } from '@/contexts/FireworksContext';

import { SyncAppEffects } from './AppEffects';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { MobileConnectionWelcome, type MobileConnectionNotice } from './MobileConnectionWelcome';
import { MobileShell } from './MobileShell';
import { autoConnectLastInstance, getAutoConnectTargetLabel, reprobeActiveConnection, type AutoConnectOutcome } from './mobileConnections';
import { MobileConnectionRecovery, isHiddenNow, isOfflineNow } from './mobile/mobileConnectionRecovery';
import { setMobileConnectionUncertain, useMobileConnectionUncertain } from './mobile/mobileRecoveryStatus';
import { subscribeRuntimeAuthExpired } from '@/lib/runtime-auth';
import { isCapacitorMobileApp, useNativeMobileChrome, useNativeMobileLifecycle } from './mobileNativeChrome';
import { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';
import { useAppFontEffects } from './useAppFontEffects';
import { useFontsReady } from './useFontsReady';
import { useDeepLinkSource } from './deepLinkNavigation';
import { useNativePushRegistration } from './useNativePushRegistration';

type MobileAppProps = {
  apis: RuntimeAPIs;
};

const NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS = 1_000;

export function MobileApp({ apis }: MobileAppProps) {
  
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const setIsMobile = useUIStore((state) => state.setIsMobile);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [showConnectionRecovery, setShowConnectionRecovery] = React.useState(false);
  // Temporary-unreachable recovery (endpoint retained, stale content kept).
  // 'idle' = healthy or explicitly disconnected; 'recovering' = paced retries
  // with the endpoint retained; 'exhausted' = bounded retries gave up but the
  // endpoint is still retained for a manual retry. Explicit disconnect (no
  // endpoint), auth-invalid (login/repair flow), and no-candidate all leave
  // recovery via cancel + endpoint clear instead of retrying.
  const [recoveryPhase, setRecoveryPhase] = React.useState<'idle' | 'recovering' | 'exhausted'>('idle');
  const isUncertain = useMobileConnectionUncertain();
  const recoveryRef = React.useRef<MobileConnectionRecovery | null>(null);
  const recoveryPhaseRef = React.useRef(recoveryPhase);
  recoveryPhaseRef.current = recoveryPhase;
  // Cold-launch auto-connect to the last instance: 'pending'/'attempting' hold the
  // splash so we don't flash the connect screen; 'done' means we either connected or
  // exhausted the attempt (then the connect screen shows).
  const [autoConnectPhase, setAutoConnectPhase] = React.useState<'pending' | 'attempting' | 'done'>('pending');
  // Why the cold-launch auto-connect fell through to the connect screen.
  const [autoConnectNotice, setAutoConnectNotice] = React.useState<MobileConnectionNotice | null>(null);
  // The instance the splash says we are connecting to. Read once on mount —
  // auto-connect targets the most-recent saved connection from the same list.
  const autoConnectLabel = React.useMemo(() => getAutoConnectTargetLabel(), []);
  // Bumped to force a re-render (and thus a fresh Pi runtime state for PiSessionProvider)
  // after a same-device transport swap — reconnects the sync layer in place with
  // no remount. The value itself is unused; only the re-render matters.
  const [, bumpTransportSwitch] = React.useReducer((count: number) => count + 1, 0);
  const isNativeMobileApp = React.useMemo(() => isCapacitorMobileApp(), []);
  const lastNativeResumeSyncEventAtRef = React.useRef(0);
  const nativeResumeValidationSeqRef = React.useRef(0);
  const autoConnectInFlightRef = React.useRef(false);

  // Temporary-unreachable recovery controller. One instance per mount; the
  // probe reuses reprobeActiveConnection (verified candidate failover,
  // direct/relay preference, temporary-tunnel cleanup), so this layer never
  // opens raw transports. Retains the endpoint, saved row, stale content,
  // drafts, and local session while retrying; explicit disconnect/host switch
  // cancels via generation + runtime identity. Native EventSource recovery
  // stays owned by the Pi transport/store and is never disposed here.
  React.useEffect(() => {
    const recovery = new MobileConnectionRecovery(
      () => reprobeActiveConnection(),
      {
        onHealthy: (outcome) => {
          setRecoveryPhase('idle');
          setMobileConnectionUncertain(false);
          if (outcome === 'unchanged') {
            void useConfigStore.getState().initializeApp();
            const snapshot = useConfigStore.getState();
            if (snapshot.providers.length === 0) void snapshot.loadProviders({ source: 'mobileApp:recovery' });
            if (snapshot.agents.length === 0) void snapshot.loadAgents({ source: 'mobileApp:recovery' });
          }
        },
        onAuthExpired: () => {
          setRecoveryPhase('idle');
          setMobileConnectionUncertain(false);
          setAutoConnectNotice({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
          switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
          setConnectionEpoch((value) => value + 1);
        },
        onNoConnection: () => {
          setRecoveryPhase('idle');
          setMobileConnectionUncertain(false);
          switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
          setConnectionEpoch((value) => value + 1);
        },
        onExhausted: () => {
          // Bounded retries gave up: keep the endpoint, saved row, stale
          // content, and drafts. Uncertainty stays true so the composer
          // keeps blocking sends instead of replaying them. A genuine
          // online/foreground/manual wake restarts a fresh bounded cycle;
          // offline/hidden wakes never restart (no background loops).
          setRecoveryPhase('exhausted');
        },
      },
      () => `${getRuntimeKey()}|${getRuntimeApiBaseUrl()}`,
    );
    recoveryRef.current = recovery;
    return () => {
      recovery.cancel();
      recoveryRef.current = null;
    };
  }, []);

  const startTemporaryRecovery = React.useCallback(() => {
    if (!isNativeMobileApp || !getRuntimeApiBaseUrl()) return;
    const recovery = recoveryRef.current;
    if (!recovery) return;
    // Wake a paused/backoff cycle instead of restarting it: restart would
    // reset the bounded attempt count and burn the delayed-wifi grace.
    if (recovery.isRunning) {
      recovery.retryNow();
      return;
    }
    setRecoveryPhase('recovering');
    setMobileConnectionUncertain(true);
    recovery.start();
  }, [isNativeMobileApp]);

  const cancelTemporaryRecovery = React.useCallback(() => {
    recoveryRef.current?.cancel();
    setRecoveryPhase('idle');
    setMobileConnectionUncertain(false);
  }, []);

  const disconnectToConnectScreen = React.useCallback((notice: MobileConnectionNotice | null) => {
    // Explicit disconnect: cancel recovery (generation bump rejects any late
    // probe), clear uncertainty (composer unmounts to the connect screen),
    // and clear the endpoint. Stale stores are reset by the endpoint-change
    // subscription; recovery never clears them itself.
    recoveryRef.current?.cancel();
    setRecoveryPhase('idle');
    setMobileConnectionUncertain(false);
    if (notice) setAutoConnectNotice(notice);
    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
    setConnectionEpoch((value) => value + 1);
  }, []);

  const dispatchThrottledSystemResume = React.useCallback(() => {
    const now = Date.now();
    if (now - lastNativeResumeSyncEventAtRef.current >= NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS) {
      lastNativeResumeSyncEventAtRef.current = now;
      window.dispatchEvent(new Event('pichamber:system-resume'));
    }
  }, []);

  const handleNativeResume = React.useCallback(() => {
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const validationSeq = nativeResumeValidationSeqRef.current + 1;
    nativeResumeValidationSeqRef.current = validationSeq;

    if (!apiBaseUrl) {
      // Already disconnected — e.g. a previous re-probe ran mid network flux
      // (Android Wi-Fi switch with no cellular fallback) and found nothing
      // reachable. When a resume/online signal arrives, silently retry the last
      // saved instance instead of dead-ending on the connect screen until the
      // user restarts the app. Success fires runtime-endpoint-changed, which
      // re-bootstraps everything. Dedup duplicate lifecycle flaps: one retry
      // owns the outcome.
      if (autoConnectInFlightRef.current) return;
      autoConnectInFlightRef.current = true;
      void autoConnectLastInstance()
        .catch(() => undefined)
        .finally(() => {
          autoConnectInFlightRef.current = false;
        });
      return;
    }

    // A recovery cycle is already pacing retries: wake it (deduped inside
    // the controller) instead of starting a parallel probe that could
    // double-switch transports.
    if (recoveryRef.current?.isRunning) {
      recoveryRef.current.retryNow();
      dispatchThrottledSystemResume();
      return;
    }
    // Exhausted (bounded retries gave up, endpoint retained): a genuine
    // online/foreground wake restarts a fresh bounded cycle so a long outage
    // wakes promptly. Offline/hidden wakes never restart (no background
    // loops); duplicate wakes collapse because the restarted cycle owns the
    // single in-flight probe token.
    if (recoveryPhaseRef.current === 'exhausted') {
      if (isOfflineNow() || isHiddenNow()) return;
      setRecoveryPhase('recovering');
      setMobileConnectionUncertain(true);
      recoveryRef.current?.start();
      dispatchThrottledSystemResume();
      return;
    }

    // Offline/hidden idle resume: hold without burning a probe against a
    // known-dead network. Entering paced recovery installs the controller's
    // online/visible wake so the genuine wake fires promptly.
    if (isOfflineNow() || isHiddenNow()) {
      startTemporaryRecovery();
      return;
    }

    // Re-probe the active device's transports on resume: the network may have
    // changed while the app slept, so hot-switch LAN⇄relay if a better transport
    // is now reachable — no re-pairing. A 'switched' outcome already fired the
    // runtime-endpoint-changed subscription (which re-bootstraps the app), so we
    // only refresh in place when the transport is 'unchanged'. The probe goes
    // through the controller's single-owner token: a duplicate resume/
    // startup/manual probe in flight returns null and commits nothing.
    const refreshInPlace = () => {
      void initializeApp();
      if (providersCount === 0) void loadProviders({ source: 'mobileApp:nativeResume' });
      if (agentsCount === 0) void loadAgents({ source: 'mobileApp:nativeResume' });
    };

    const recovery = recoveryRef.current;
    if (!recovery) return;
    void recovery.probeOnce().then((outcome) => {
      if (outcome === null) return;
      if (nativeResumeValidationSeqRef.current !== validationSeq) return;
      // A recovery cycle started while this probe was in flight (e.g. a
      // second resume restarted from exhausted): the stale result commits
      // nothing; the cycle owns it. A runtime switch/disconnect mid-probe is
      // already rejected inside probeOnce via runtime identity.
      if (recoveryRef.current?.isRunning) return;
      if (recoveryPhaseRef.current === 'exhausted') return;
      if (outcome === 'no-connection') {
        disconnectToConnectScreen(null);
        return;
      }
      if (outcome === 'needs-login') {
        // Token explicitly rejected (revoked/expired) — enter the existing
        // repair/login path, never the bounded network retry loop.
        disconnectToConnectScreen({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
        return;
      }
      if (outcome === 'unreachable') {
        // Temporarily unreachable (resume race, delayed wifi, dead LAN):
        // retain the endpoint/row/content/drafts and enter paced recovery.
        // The first backoff slot (1s) covers the network-settling grace that
        // the old single 4s retry handled; delayed wifi wakes via online.
        startTemporaryRecovery();
        return;
      }
      if (outcome === 'switched') return;

      refreshInPlace();
    });

    dispatchThrottledSystemResume();
  }, [agentsCount, disconnectToConnectScreen, dispatchThrottledSystemResume, initializeApp, loadAgents, loadProviders, providersCount, startTemporaryRecovery]);

  useNativeMobileChrome();
  useNativeMobileLifecycle(handleNativeResume);

  React.useEffect(() => startMobileErrorLogCapture(), []);

  // Network-change re-probe. The resume hook only fires on background→foreground,
  // but on Android switching Wi-Fi (quick-settings tile) does NOT background the
  // app — no visibility/appState event ever fires, so the app would sit on a dead
  // LAN transport instead of hot-switching to relay. The webview's `online` event
  // fires on connectivity changes (new Wi-Fi, cellular back, airplane off), so
  // run the same re-probe then. While a recovery cycle is pacing, wake it
  // directly (deduped inside the controller) so delayed wifi fires the first
  // retry immediately instead of waiting out the debounce. An exhausted cycle
  // restarts as a fresh bounded cycle on this genuine online wake (unless
  // hidden — no hidden loops). Otherwise debounce:
  // the first seconds after `online` the route is often not usable yet, and
  // rapid offline/online flaps must collapse into one probe.
  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    let timer: number | undefined;
    const handleOnline = () => {
      // Recovery owns its own online/visible wake listeners during backoff;
      // this only shortens the MobileApp-level debounce for the idle path.
      // A running cycle wakes immediately (deduped).
      if (recoveryRef.current?.isRunning) {
        recoveryRef.current.retryNow();
        return;
      }
      if (recoveryPhaseRef.current === 'exhausted') {
        if (isHiddenNow()) return;
        setRecoveryPhase('recovering');
        setMobileConnectionUncertain(true);
        recoveryRef.current?.start();
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => handleNativeResume(), 1500);
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearTimeout(timer);
    };
  }, [isNativeMobileApp, handleNativeResume]);

  // Established auth-expired flow for the native shell. Long-lived Pi
  // transport stops retrying on a confirmed 401 and notifies via
  // `subscribeRuntimeAuthExpired`; the shell must handle it immediately:
  // cancel recovery (generation rejects any late probe so a runtime
  // switch/disconnect cannot late side effect), preserve drafts and saved
  // credentials per contract (the saved row stays; only the active endpoint
  // clears), and enter the re-pair/login notice. No store clearing here.
  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    return subscribeRuntimeAuthExpired(() => {
      if (!getRuntimeApiBaseUrl()) return;
      recoveryRef.current?.cancel();
      setRecoveryPhase('idle');
      setMobileConnectionUncertain(false);
      setAutoConnectNotice({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
      setConnectionEpoch((value) => value + 1);
    });
  }, [isNativeMobileApp]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  // Switching instances (or disconnecting) only changes the runtime endpoint; the
  // stores still hold the previous instance's data. Mirror the web App.tsx reset
  // sequence so the UI fully re-bootstraps against the new server instead of going
  // stale. The PiSessionProvider is keyed by runtimeEndpointEpoch so it remounts too.
  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      // A LAN⇄relay swap for the SAME device keeps the runtime key stable. Treat
      // that as a transport-only change: rebind the sync layer to the new
      // transport but keep the user's session/connection state — no reconnecting
      // screen, no bounce back to the draft. Only a real instance switch (key
      // change) does the full reset.
      const sameDevice = Boolean(detail.runtimeKey) && detail.runtimeKey === detail.previousRuntimeKey;
      if (sameDevice) {
        // Transport-only swap for the same device: rebind the Pi transport and
        // force a re-render so PiSessionProvider observes the new runtime endpoint,
        // then reconnect without remounting — so the message
        // pagination refs, the open session, and the whole view are preserved.
        // No key bump, no flash, no bounce to the draft.
        // The recovery cycle (if running) resolves via its onHealthy callback
        // after the probe returns; do not cancel it here or the healthy signal
        // would be lost.
        reconnectAppForTransportSwitch();
        bumpTransportSwitch();
        return;
      }
      // Explicit disconnect or host switch: abandon recovery so a late probe
      // for the old endpoint cannot undo it (generation + runtime identity
      // already reject it, this clears the banner/uncertainty immediately).
      recoveryRef.current?.cancel();
      setRecoveryPhase('idle');
      setMobileConnectionUncertain(false);
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setConnectionEpoch((epoch) => epoch + 1);
    });
  }, []);

  React.useEffect(() => {
    // Runtime settings must be reloaded after the new endpoint is
    // authenticated. If the switch requires login, this component unmounts
    // while the auth gate is pending and avoids an avoidable 401 burst.
    void syncDesktopSettings();
  }, [runtimeEndpointEpoch]);

  // On cold launch, silently reconnect to the most-recent saved instance so a
  // returning user — and notification deep-links — land in the app instead of the
  // connect screen. The splash is held while we try (see render below). If there's
  // no saved instance, it's unreachable, or it needs a (re)login, we fall through
  // to the connect screen. A successful switchRuntimeEndpoint fires the endpoint-
  // changed subscription above, which bumps the epochs and bootstraps the app.
  React.useEffect(() => {
    if (!isNativeMobileApp || isConnected || getRuntimeApiBaseUrl()) {
      setAutoConnectPhase('done');
      return;
    }
    let cancelled = false;
    setAutoConnectPhase('attempting');
    void autoConnectLastInstance()
      .catch((): AutoConnectOutcome => ({ status: 'no-candidate' }))
      .then((outcome) => {
        if (cancelled) return;
        // Landing on the connect screen silently reads as data loss — say WHY
        // the saved instance didn't come back (unreachable vs revoked auth).
        if (outcome.status === 'unreachable') {
          setAutoConnectNotice({ kind: 'unreachable', label: outcome.label });
        } else if (outcome.status === 'needs-login') {
          setAutoConnectNotice({ kind: 'auth-expired', label: outcome.label });
        }
        setAutoConnectPhase('done');
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount — auto-connect is a cold-launch concern only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cold launch with a PERSISTED runtime endpoint (the auto-connect effect
  // above skips this case): the app used to just sit on the recovery splash
  // for 8s while bootstrap failed, then show a vague "unable to reach server"
  // screen. Classify the failure with a fast re-probe instead: unreachable or
  // rejected auth drops straight to the connect screen with a banner saying
  // why; a switched/alive transport lets bootstrap proceed as usual. The
  // probe goes through the controller's single-owner token so a concurrent
  // resume/startup duplicate commits nothing (returns null).
  React.useEffect(() => {
    // NOTE: do NOT gate on isConnected here — the persisted store can claim a
    // stale `isConnected: true` at mount, which would skip the classification
    // exactly when it's needed. Check it at resolution time instead.
    if (!isNativeMobileApp || !getRuntimeApiBaseUrl()) return;
    let cancelled = false;
    const dropToConnectScreen = (notice: MobileConnectionNotice | null) => {
      if (notice) setAutoConnectNotice(notice);
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
      setConnectionEpoch((value) => value + 1);
    };
    const recovery = recoveryRef.current;
    if (!recovery) return;
    void recovery.probeOnce().then(async (outcome) => {
      if (cancelled || outcome === null) return;
      // A genuinely live connection established itself while we probed.
      if (outcome === 'switched' || outcome === 'unchanged') return;
      const label = getAutoConnectTargetLabel();
      if (outcome === 'needs-login') {
        dropToConnectScreen({ kind: 'auth-expired', label: label ?? '' });
        return;
      }
      if (outcome === 'unreachable') {
        dropToConnectScreen(label ? { kind: 'unreachable', label } : null);
        return;
      }
      // 'no-connection': at cold start the runtime key may not map to a saved
      // connection yet — fall back to the auto-connect path, which both
      // classifies the failure and connects when everything is actually fine.
      const fallback = await autoConnectLastInstance().catch((): AutoConnectOutcome => ({ status: 'no-candidate' }));
      if (cancelled || fallback.status === 'connected') return;
      if (fallback.status === 'needs-login') {
        dropToConnectScreen({ kind: 'auth-expired', label: fallback.label });
      } else if (fallback.status === 'unreachable') {
        dropToConnectScreen({ kind: 'unreachable', label: fallback.label });
      } else {
        dropToConnectScreen(null);
      }
    });
    return () => {
      cancelled = true;
    };
    // Run once on mount — a cold-launch classification only; live drops are
    // handled by the resume/online re-probe paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    // Never bootstrap without a runtime endpoint on native: with apiBaseUrl ''
    // the resolver falls back to the webview's own origin, where Capacitor's
    // static server answers every request with index.html — the bootstrap
    // "succeeds" against a fake backend and flips isConnected back on, leaving
    // the user in an empty shell after a disconnect.
    if (isNativeMobileApp && !getRuntimeApiBaseUrl()) return;
    void initializeApp();
  }, [connectionEpoch, initializeApp, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'mobileApp:recovery' });
    if (agentsCount === 0) void loadAgents({ source: 'mobileApp:recovery' });
  }, [agentsCount, isConnected, loadAgents, loadProviders, providersCount]);

  // Cold-launch continuity: after the launch instance connects, reopen the
  // session that was open on this instance last time — but only after an
  // authoritative sessions snapshot confirms it still exists, and only if the
  // user hasn't opened a session in the meantime. An open new-session draft
  // does NOT block the restore: ChatContainer auto-opens the draft whenever no
  // session is active, so at this point it reflects the boot default, not a
  // user choice. Runs once per successful launch connect; in-app instance
  // switches keep using the in-memory per-runtime session memory instead.
  const lastSessionRestoreDoneRef = React.useRef(false);
  // While true, a logo overlay covers the shell so the user never sees the
  // intermediate auto-opened draft before the restore decision lands.
  const [lastSessionRestorePending, setLastSessionRestorePending] = React.useState(isNativeMobileApp);
  React.useEffect(() => {
    if (!isNativeMobileApp || !isConnected || lastSessionRestoreDoneRef.current) return;
    if (useSessionUIStore.getState().currentSessionId) {
      lastSessionRestoreDoneRef.current = true;
      setLastSessionRestorePending(false);
      return;
    }
    const runtimeKey = getRuntimeKey();
    const persisted = readLastActiveSession(runtimeKey);
    if (!persisted) {
      lastSessionRestoreDoneRef.current = true;
      setLastSessionRestorePending(false);
      return;
    }
    let cancelled = false;
    // Safety valve: the overlay must never strand the user on the splash if
    // the snapshot hangs — fall through to the draft after a bounded wait.
    const overlayTimeoutId = window.setTimeout(() => setLastSessionRestorePending(false), 6000);
    void (async () => {
      // `null` = fetch failure — keep the ref unset so the next connect (a
      // stale persisted isConnected can fire this early) retries the restore.
      const snapshot = await refreshGlobalSessions().catch(() => null);
      if (cancelled) return;
      if (!snapshot) {
        setLastSessionRestorePending(false);
        return;
      }
      lastSessionRestoreDoneRef.current = true;
      const session = snapshot.activeSessions.find((entry) => entry.id === persisted.sessionId);
      if (!session) {
        // Authoritative snapshot says the session is gone (deleted/archived) —
        // drop the stale pointer instead of retrying it on every launch.
        clearLastActiveSession(runtimeKey);
        setLastSessionRestorePending(false);
        return;
      }
      const latest = useSessionUIStore.getState();
      if (!latest.currentSessionId) {
        void latest.setCurrentSession(
          session.id,
          resolveGlobalSessionDirectory(session) ?? persisted.directory ?? undefined,
        );
      }
      setLastSessionRestorePending(false);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(overlayTimeoutId);
    };
  }, [connectionEpoch, isConnected, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    void getPiSessionStore().focusProject(currentDirectory, null);
  }, [currentDirectory, isConnected]);

  React.useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  React.useEffect(() => {
    // Recovery owns its own banner while pacing: the generic splash/error
    // path must not cover the retained shell with a loader.
    if (isNativeMobileApp && recoveryPhase !== 'idle') {
      setShowConnectionRecovery(false);
      return;
    }
    // Native: only while an instance is selected and reconnecting. Browser: the
    // runtime is same-origin (no explicit base URL), so any not-connected spell
    // counts — the splash holds until this fires, then the error screen shows.
    const waitingOnConnection = !isConnected && (isNativeMobileApp ? Boolean(getRuntimeApiBaseUrl()) : true);
    if (!waitingOnConnection) {
      setShowConnectionRecovery(false);
      return;
    }
    // Native decides faster: the cold-start classification has usually already
    // resolved by then, so this is the "server picked but bootstrap won't
    // finish" fallback (e.g. older servers where auth can't be probed).
    const timeout = window.setTimeout(() => {
      setShowConnectionRecovery(true);
    }, isNativeMobileApp ? 4000 : 8000);
    return () => window.clearTimeout(timeout);
  }, [isConnected, isNativeMobileApp, connectionEpoch, recoveryPhase, runtimeEndpointEpoch]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useRouter();
  // APNs is the only notification channel on the native app (background-capable,
  // focus-suppressed server-side via the visibility beacon). Local notifications are
  // intentionally disabled — they can't tell foreground from background in a WKWebView
  // (document.hasFocus() is unreliable) and leaked while the app was open; the in-app SSE
  // notification dispatch is no-op'd for native in renderMobileApp.
  useNativePushRegistration({ enabled: isNativeMobileApp && isConnected });
  // Single native deep-link entry point: notification taps AND the pichamber:// URL
  // scheme (widgets, Live Activities, external links). Registered unconditionally so a
  // cold-launch tap/open isn't lost on the connect/splash screen; intents stash until
  // the app is ready (connected + initialized) and shell handlers are registered.
  useDeepLinkSource({ ready: isNativeMobileApp && isConnected && isInitialized });
  const fontsReady = useFontsReady();

  // `isConnected` is a LIVE flag that flips false on every transient SSE/WS drop and
  // back true on reconnect. We must NOT blank the whole app to a loader on those —
  // only on the initial connect / instance switch (connectionPhase 'connecting').
  // While 'reconnecting' (we were connected before), keep MobileShell mounted so the
  // UI doesn't reload on every network blip.
  const isReconnecting = !isConnected && connectionPhase === 'reconnecting';

  // No runtime endpoint on native = explicitly disconnected (last instance
  // deleted, revoked token, unreachable). The connect screen is the only valid
  // UI then — regardless of what a stale isConnected flag claims (the store can
  // be poisoned by a bootstrap that ran against the webview's own origin).
  const hasRuntimeEndpoint = Boolean(getRuntimeApiBaseUrl());
  // Temporary-unreachable recovery retains the endpoint/row/content/drafts and
  // keeps the shell mounted (stale readonly) instead of blanking to a loader.
  // Distinct states: no endpoint = user disconnected; recovering = pacing
  // retries; exhausted = bounded retries gave up (genuine online/foreground/
  // manual wake restarts a fresh bounded cycle); otherwise
  // synced (or initial connecting/reconnecting).
  const inTemporaryRecovery = isNativeMobileApp && hasRuntimeEndpoint && recoveryPhase !== 'idle';
  const recoveryLabel = getAutoConnectTargetLabel() ?? '';
  const handleRecoveryRetryNow = React.useCallback(() => {
    const recovery = recoveryRef.current;
    if (!recovery) return;
    // A pacing cycle owns the single probe token: wake it (deduped) instead
    // of restarting and burning the bounded count. Exhausted manual retry
    // starts a fresh bounded cycle (offline/hidden holds with the long cap
    // inside the controller — no probe burned, wakes on online/visible).
    // Both keep the endpoint and stale content. Checking isRunning first
    // dedups rapid double-taps: the second tap wakes the just-started cycle
    // instead of starting again.
    if (recovery.isRunning) {
      recovery.retryNow();
      return;
    }
    setRecoveryPhase('recovering');
    setMobileConnectionUncertain(true);
    recovery.start();
  }, []);
  const handleRecoverySwitchServer = React.useCallback(() => {
    disconnectToConnectScreen(null);
  }, [disconnectToConnectScreen]);

  // Hold a logo splash until the UI web font is loaded, so the first UI the user sees
  // already uses the real font instead of flashing the fallback and reflowing (FOUT).
  if (!fontsReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <PiChamberLogo width={120} height={120} isAnimated />
      </main>
    );
  }

  if (isNativeMobileApp && !inTemporaryRecovery && (!hasRuntimeEndpoint || (!isConnected && !isReconnecting))) {
    // A runtime endpoint is already selected (first connect or switching instances):
    // show a loader while it re-bootstraps instead of flashing the onboarding screen.
    if (hasRuntimeEndpoint) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-4">
            <PiChamberLogo width={120} height={120} isAnimated={!showConnectionRecovery} />
            {showConnectionRecovery ? (
              <>
                <div className="space-y-2">
                  <h1 className="typography-h3 text-foreground">{"Unable to reach server"}</h1>
                  {/* Native copy — the browser-oriented sessionAuth description
                      (Desktop Network Access etc.) reads as noise here. */}
                  <p className="typography-body text-muted-foreground">{"Could not connect to the saved server. Check that it is running, or pick another instance."}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    disconnectToConnectScreen(null);
                  }}
                >
                  {"Use another server"}
                </Button>
              </>
            ) : null}
          </div>
        </main>
      );
    }
    // Cold-launch auto-connect is still resolving — hold the splash instead of
    // flashing the connect screen. Only show the connect screen once we've finished
    // (no saved instance, unreachable, or needs re-login).
    if (autoConnectPhase !== 'done') {
      return (
        <main className="relative flex min-h-dvh items-center justify-center bg-background text-foreground">
          <PiChamberLogo width={120} height={120} isAnimated />
          {/* Absolutely positioned below the (still perfectly centered) logo so
              the text never pushes it up. 50% + half the 120px logo + a gap. */}
          {autoConnectLabel ? (
            <div className="absolute inset-x-0 top-[calc(50%+84px)] flex flex-col items-center gap-0.5 px-6 text-center">
              <p className="typography-small text-muted-foreground">{"Connecting to device:"}</p>
              <div className="flex justify-center">
                <AgentThinkingLoader text={autoConnectLabel} showElapsed={false} />
              </div>
            </div>
          ) : null}
        </main>
      );
    }
    return (
      <>
        <MobileConnectionWelcome
          onConnected={() => setConnectionEpoch((value) => value + 1)}
          notice={autoConnectNotice}
        />
      </>
    );
  }

  if (!isConnected && !isReconnecting) {
    // Browser: the initial connect takes a beat — hold the logo splash instead
    // of flashing the unreachable-server error while it resolves. The error
    // only shows once the recovery delay has expired (genuinely unreachable).
    if (!showConnectionRecovery) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
          <PiChamberLogo width={120} height={120} isAnimated />
        </main>
      );
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-3">
          <h1 className="typography-h3 text-foreground">{"Unable to reach server"}</h1>
          <p className="typography-body text-muted-foreground">{"We could not verify the UI session. If you're opening PiChamber from another device on your local network, make sure Desktop Network Access is enabled on the desktop app and use the LAN address shown in Settings."}</p>
        </div>
      </main>
    );
  }

  return (
    <ErrorBoundary>
      <PiSessionProvider key={runtimeEndpointEpoch}>
        <RuntimeAPIProvider apis={apis}>
          <WindowTitleEffect />
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <FireworksProvider>
              <DeferredUpdatePolling />
              <div className="h-full bg-background text-foreground">
                {/* Cold-launch continuity: keep the boot logo up over the shell
                    until the last-session restore decides between session and
                    draft — otherwise the auto-opened draft flashes first. The
                    shell (and sync) still mounts and warms up underneath. */}
                {isNativeMobileApp && lastSessionRestorePending ? (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
                    <PiChamberLogo width={120} height={120} isAnimated />
                  </div>
                ) : null}
                {/* Queued auto-send stays disabled while the transport is
                    uncertain: queued prompts remain local and drain only after
                    a verified healthy probe, never as a silent replay of an
                    uncertain mutation. */}
                <SyncAppEffects embeddedBackgroundWorkEnabled={isInitialized && !isUncertain} />
                {inTemporaryRecovery ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className={recoveryPhase === 'exhausted'
                      ? 'flex items-center gap-3 border-b border-[color-mix(in_srgb,var(--status-error)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)] px-4 py-2.5'
                      : 'flex items-center gap-3 border-b border-[color-mix(in_srgb,var(--status-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_10%,transparent)] px-4 py-2.5'}
                  >
                    <span className={recoveryPhase === 'exhausted'
                      ? 'flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-[color-mix(in_srgb,var(--status-error)_16%,transparent)] text-[var(--status-error)]'
                      : 'flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-[color-mix(in_srgb,var(--status-warning)_16%,transparent)] text-[var(--status-warning)]'}
                    >
                      <Icon name={recoveryPhase === 'exhausted' ? 'cloud-off' : 'loader-4'} className={recoveryPhase === 'exhausted' ? 'size-[18px]' : 'size-[18px] animate-spin'} />
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate typography-ui-label text-foreground">
                        {recoveryPhase === 'exhausted'
                          ? (recoveryLabel ? `Couldn't reach ${recoveryLabel}` : 'Server unreachable')
                          : 'Reconnecting…'}
                      </span>
                      <span className="block truncate typography-small text-muted-foreground">
                        {recoveryPhase === 'exhausted'
                          ? 'Chats and drafts are kept. Check the server, then try again.'
                          : 'Keeping chats and drafts. Retrying automatically.'}
                      </span>
                    </span>
                    <Button type="button" size="sm" onClick={handleRecoveryRetryNow}>
                      {recoveryPhase === 'exhausted' ? 'Try again' : 'Retry now'}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={handleRecoverySwitchServer}>
                      {'Use another server'}
                    </Button>
                  </div>
                ) : null}
                <MobileAppUpdateToast />
                <MobileShell onActiveConnectionDeleted={() => {
                  // Deleting the active connection is an explicit disconnect:
                  // abandon recovery so no late probe can resurrect it.
                  cancelTemporaryRecovery();
                  switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                  setConnectionEpoch((value) => value + 1);
                }} />
                <SessionDialogs />
                <WorktreeCreationToasts />
                <Toaster position="top-center" offset="calc(var(--oc-safe-area-top, 0px) + 16px)" />
                <PerfHudHost />
              </div>
            </FireworksProvider>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </PiSessionProvider>
    </ErrorBoundary>
  );
}
