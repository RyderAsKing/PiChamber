import React from 'react';

import { piClient } from '@/lib/pi/client';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { PiExtensionListResponse } from '@/lib/pi/protocol';

export interface InstalledExtension {
  id: string;
  name: string;
}

export interface ExtensionCommand {
  name: string;
  description?: string;
  source?: 'extension' | 'prompt' | 'skill';
  scope?: 'user' | 'project' | 'temporary';
}

export interface UseInstalledExtensionsResult {
  extensions: InstalledExtension[];
  commands: ExtensionCommand[];
  directory?: string;
  isLoading: boolean;
  /** True when the last fetch failed; the previous lists are preserved. */
  failed: boolean;
  refresh: () => void;
}

const EMPTY: PiExtensionListResponse = { extensions: [], commands: [] };

/**
 * Extensions loaded for a directory, and the commands they register.
 *
 * `GET /api/pi/extensions` answers from the session daemon, which is the only
 * place that knows what Pi actually loaded. The server sends opaque ids, never
 * filesystem paths, so this is safe to render as-is.
 *
 * Scoped by runtime + directory: switching either discards the previous
 * server's list rather than showing it under the new scope. A failed refresh
 * keeps the last known list, so a transient daemon error does not blank the
 * panel.
 */
export function useInstalledExtensions(directory?: string): UseInstalledExtensionsResult {
  const normalizedDirectory = directory?.trim() ? directory.trim() : undefined;
  const [state, setState] = React.useState<{
    extensions: InstalledExtension[];
    commands: ExtensionCommand[];
    directory?: string;
    failed: boolean;
  }>({ extensions: [], commands: [], failed: false });
  const [isLoading, setIsLoading] = React.useState(false);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);

  // Runtime switches must never reuse the previous server's extensions.
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setState({ extensions: [], commands: [], failed: false });
    setRuntimeEpoch((epoch) => epoch + 1);
  }), []);

  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      let result: PiExtensionListResponse = EMPTY;
      let failed = false;
      try {
        result = await piClient.listExtensions(normalizedDirectory, { runtimeKey });
      } catch {
        failed = true;
      }
      if (cancelled || getRuntimeKey() !== runtimeKey) return;
      setState((previous) => (
        failed
          // A failed refresh keeps what we already showed for this scope.
          ? { ...previous, failed: true }
          : { extensions: result.extensions ?? [], commands: result.commands ?? [], directory: result.directory, failed: false }
      ));
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [normalizedDirectory, refreshToken, runtimeEpoch]);

  const refresh = React.useCallback(() => setRefreshToken((token) => token + 1), []);

  return {
    extensions: state.extensions,
    commands: state.commands,
    directory: state.directory,
    isLoading,
    failed: state.failed,
    refresh,
  };
}
