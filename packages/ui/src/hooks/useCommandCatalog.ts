import React from "react";

import { piClient } from "@/lib/pi/client";
import {
  buildSystemCatalogCommands,
  clearCommandCatalogForRuntimeSwitch,
  getCommandCatalogInvalidationRevision,
  readCommandCatalogCache,
  subscribeCommandCatalogInvalidation,
  toCatalogCommands,
  writeCommandCatalogCache,
  type CatalogCommand,
} from "@/lib/pi/commandCatalog";
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from "@/lib/runtime-switch";
import { usePromptTemplatesStore } from "@/stores/usePromptTemplatesStore";
import { useSkillsStore } from "@/stores/useSkillsStore";

const inFlightByScope = new Map<string, Promise<CatalogCommand[] | null>>();

const scopeKey = (runtimeKey: string, directory?: string): string =>
  `${runtimeKey}\n${directory?.trim() ?? ""}`;

/**
 * Authoritative slash-command catalog for an effective directory.
 *
 * Combines PiChamber system commands with native Pi prompts, skills
 * (`skill:name`), and extension commands from `/api/pi/commands`. Scoped by
 * runtime + directory; failed refreshes preserve the last known catalog for
 * the same scope and never become empty success. Runtime switches clear.
 *
 * Prompt create/update/delete, extension reload, and skill reload invalidate
 * via their owning stores (which bump the observed revisions below) so both
 * `/` autocomplete and composer highlighting agree.
 */
export function useCommandCatalog(directory?: string): {
  commands: CatalogCommand[];
  isLoading: boolean;
} {
  const normalizedDirectory = directory?.trim() ? directory.trim() : undefined;
  const invalidationRevision = React.useSyncExternalStore(
    subscribeCommandCatalogInvalidation,
    getCommandCatalogInvalidationRevision,
    getCommandCatalogInvalidationRevision,
  );
  // Prompt and skill mutations update these stores from their mutation
  // responses; observing their identities invalidates this catalog without
  // duplicating Pi resource discovery here.
  const promptSignature = usePromptTemplatesStore((s) =>
    s.prompts.map((p) => `${p.id}:${p.name}:${p.location}`).join("|"),
  );
  const skillSignature = useSkillsStore((s) =>
    s.skills.map((sk) => `${sk.id}:${sk.name}:${sk.scope}`).join("|"),
  );

  const [commands, setCommands] = React.useState<CatalogCommand[]>(() => {
    if (!normalizedDirectory) return buildSystemCatalogCommands();
    const cached = readCommandCatalogCache(getRuntimeKey(), normalizedDirectory);
    return cached ? [...buildSystemCatalogCommands(), ...cached] : buildSystemCatalogCommands();
  });
  const [isLoading, setIsLoading] = React.useState(false);
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);
  const lastScopeRef = React.useRef<string | undefined>(undefined);

  // Runtime switches must never reuse the previous server's commands.
  React.useEffect(() => {
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      clearCommandCatalogForRuntimeSwitch();
      inFlightByScope.clear();
      lastScopeRef.current = undefined;
      setCommands(buildSystemCatalogCommands());
      setRuntimeEpoch((e) => e + 1);
    });
    return unsubscribe;
  }, []);

  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    const scope = scopeKey(runtimeKey, normalizedDirectory);
    const requestKey = `${scope}\n${invalidationRevision}`;
    if (!normalizedDirectory) {
      lastScopeRef.current = scope;
      setCommands(buildSystemCatalogCommands());
      return;
    }
    // Directory switches never show another directory's rows while loading.
    if (lastScopeRef.current !== scope) {
      lastScopeRef.current = scope;
      const cached = readCommandCatalogCache(runtimeKey, normalizedDirectory);
      setCommands(cached ? [...buildSystemCatalogCommands(), ...cached] : buildSystemCatalogCommands());
    }
    let cancelled = false;
    setIsLoading(true);
    const existing = inFlightByScope.get(requestKey);
    let request: Promise<CatalogCommand[] | null>;
    if (existing) {
      request = existing;
    } else {
      const requestRevision = invalidationRevision;
      request = (async () => {
        try {
          const result = await piClient.listCommands(normalizedDirectory, { runtimeKey });
          if (getRuntimeKey() !== runtimeKey) return null;
          if (getCommandCatalogInvalidationRevision() !== requestRevision) return null;
          const catalog = toCatalogCommands(result.commands);
          writeCommandCatalogCache(runtimeKey, normalizedDirectory, catalog);
          return catalog;
        } catch {
          return null;
        } finally {
          inFlightByScope.delete(requestKey);
        }
      })();
      inFlightByScope.set(requestKey, request);
    }
    void request.then((catalog) => {
      if (cancelled) return;
      if (getRuntimeKey() !== runtimeKey) return;
      // Failure preserves the last known catalog for the same scope;
      // only a successful authoritative fetch replaces it.
      if (catalog) {
        setCommands([...buildSystemCatalogCommands(), ...catalog]);
      }
      setIsLoading(false);
    }).catch(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedDirectory, promptSignature, skillSignature, runtimeEpoch, invalidationRevision]);

  return { commands, isLoading };
}
