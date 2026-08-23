import React from 'react';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { DictationAudioCapture, isDictationCaptureSupported } from './audio-capture';
import { DictationClient } from './dictation-client';
import type { DictationController, DictationState } from './dictation-state';

export interface ComposerDictationController extends DictationController {
  available: boolean;
}

export function useComposerDictation(): ComposerDictationController {
  const [state, setState] = React.useState<DictationState>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [available, setAvailable] = React.useState(false);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const captureRef = React.useRef<DictationAudioCapture | null>(null);
  const clientRef = React.useRef<DictationClient | null>(null);
  const providerConfigIdRef = React.useRef('local');
  const startedAtRef = React.useRef(0);
  const generationRef = React.useRef(0);

  const refreshAvailability = React.useCallback(async () => {
    const response = await runtimeFetch('/api/stt/status');
    if (!response.ok) throw new Error('Could not read dictation settings');
    const payload = await response.json() as { config?: { enabled?: boolean; providerConfigId?: string } };
    providerConfigIdRef.current = payload.config?.providerConfigId || 'local';
    setAvailable(payload.config?.enabled === true && isDictationCaptureSupported());
  }, []);

  React.useEffect(() => {
    void refreshAvailability().catch(() => {});
    return subscribeRuntimeEndpointChanged(() => {
      generationRef.current += 1;
      clientRef.current?.cancel();
      void captureRef.current?.stop();
      clientRef.current = null;
      captureRef.current = null;
      setState('idle');
      setError(null);
      setAvailable(false);
      void refreshAvailability().catch(() => {});
    });
  }, [refreshAvailability]);

  React.useEffect(() => {
    if (!startedAtRef.current || (state !== 'recording' && state !== 'reconnecting')) return;
    const update = () => setElapsedSeconds(Math.min(300, Math.floor((Date.now() - startedAtRef.current) / 1000)));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  const stopCaptureAfterError = React.useCallback((nextError: Error) => {
    setError(nextError.message);
    setState('error');
    void captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  const start = React.useCallback(async () => {
    if (!available || state === 'requesting-permission' || state === 'recording' || state === 'reconnecting' || state === 'transcribing') return;
    setError(null);
    setElapsedSeconds(0);
    setState('requesting-permission');
    const generation = ++generationRef.current;
    const client = new DictationClient(
      providerConfigIdRef.current,
      (nextState) => { if (generationRef.current === generation) setState(nextState); },
      (nextError) => { if (generationRef.current === generation) stopCaptureAfterError(nextError); },
    );
    const capture = new DictationAudioCapture({
      onChunk: (chunk) => client.append(chunk),
      onPermissionGranted: () => {
        if (generationRef.current !== generation) return;
        startedAtRef.current = Date.now();
        setState('recording');
      },
    });
    clientRef.current = client;
    captureRef.current = capture;
    try {
      await capture.start();
      client.begin();
    } catch (cause) {
      client.cancel();
      await capture.stop().catch(() => {});
      if (generationRef.current !== generation) return;
      clientRef.current = null;
      captureRef.current = null;
      startedAtRef.current = 0;
      const nextError = cause instanceof Error ? cause : new Error(String(cause));
      setError(nextError.name === 'NotAllowedError' ? 'Microphone access was denied' : nextError.message);
      setState('error');
      throw nextError;
    }
  }, [available, state, stopCaptureAfterError]);

  const finish = React.useCallback(async () => {
    const client = clientRef.current;
    const capture = captureRef.current;
    if (!client || !capture) throw new Error('No dictation recording is active');
    const generation = generationRef.current;
    setState('transcribing');
    try {
      await capture.stop();
      if (generationRef.current !== generation || clientRef.current !== client) throw new Error('Dictation cancelled');
      captureRef.current = null;
      const text = await client.finish();
      if (generationRef.current !== generation) throw new Error('Dictation cancelled');
      clientRef.current = null;
      startedAtRef.current = 0;
      setState('idle');
      setError(null);
      return text;
    } catch (cause) {
      const nextError = cause instanceof Error ? cause : new Error(String(cause));
      if (generationRef.current === generation) {
        setError(nextError.message);
        setState('error');
      }
      throw nextError;
    }
  }, []);

  const cancel = React.useCallback(() => {
    generationRef.current += 1;
    clientRef.current?.cancel();
    clientRef.current = null;
    void captureRef.current?.stop();
    captureRef.current = null;
    startedAtRef.current = 0;
    setElapsedSeconds(0);
    setError(null);
    setState('idle');
  }, []);

  React.useEffect(() => cancel, [cancel]);

  const subscribeLevel = React.useCallback((listener: (level: number) => void) => {
    return captureRef.current?.subscribeLevel(listener) ?? (() => {});
  }, []);

  return { state, error, available, elapsedSeconds, start, finish, cancel, subscribeLevel };
}
