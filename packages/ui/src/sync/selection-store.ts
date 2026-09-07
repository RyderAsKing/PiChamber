/**
 * Selection Store — canonical per-session model, agent, and variant preferences.
 *
 * Single owner for `sessionModelSelections`, `sessionAgentSelections`,
 * `sessionAgentModelSelections`, and `sessionAgentModelVariantSelections` plus
 * `lastUsedProvider`. Opening an existing chat restores from the hydrated Pi
 * session first; this store is the fallback for remembered per-session picks.
 *
 * Migration: the retired `context-store` is read once from disk and folded in.
 * Canonical values win on conflict; legacy fills gaps. `currentAgentContext`
 * is a fallback for missing agent selections only, never a second live map.
 *
 * After `contextStoreMigrationVersion === 1` is persisted, absent entries are
 * authoritative and the legacy key is never consulted again. The legacy disk
 * key is left untouched as a read-only recovery backup; it is not a live
 * fallback.
 *
 * Retention is intentionally unbounded, matching the legacy store.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { createDeferredSafeJSONStorage, getSafeStorage } from "@/stores/utils/safeStorage"

type ModelSelection = { providerId: string; modelId: string }
type LastUsedProvider = { providerID: string; modelID: string }

export const SELECTION_STORE_KEY = "selection-store"
export const SELECTION_STORE_VERSION = 2
export const LEGACY_CONTEXT_STORE_KEY = "context-store"
export const CONTEXT_STORE_MIGRATION_VERSION = 1

export type SelectionState = {
  sessionModelSelections: Map<string, ModelSelection>
  sessionAgentSelections: Map<string, string>
  sessionAgentModelSelections: Map<string, Map<string, ModelSelection>>
  sessionAgentModelVariantSelections: Map<string, Map<string, Map<string, string>>>
  lastUsedProvider: LastUsedProvider | null
  hasHydrated: boolean
  contextStoreMigrationVersion?: number
  clearedVariantKeys: string[]

  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === "string"

const isModelSelection = (value: unknown): value is ModelSelection => (
  typeof value === "object" && value !== null
  && typeof (value as ModelSelection).providerId === "string"
  && typeof (value as ModelSelection).modelId === "string"
)

const buildVariantModelKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`
const buildVariantTombstoneKey = (sessionId: string, agentName: string, modelKey: string) =>
  JSON.stringify([sessionId, agentName, modelKey])
const buildAgentModelDirtyKey = (sessionId: string, agentName: string) =>
  JSON.stringify([sessionId, agentName])

const parseTombstoneKey = (key: string): [string, string, string] | null => {
  try {
    const parsed: unknown = JSON.parse(key)
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every(isString)) {
      return parsed as [string, string, string]
    }
  } catch {
    // Corrupt keys are ignored; merged maps stay authoritative.
  }
  return null
}

const parseAgentModelDirtyKey = (key: string): [string, string] | null => {
  try {
    const parsed: unknown = JSON.parse(key)
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(isString)) {
      return parsed as [string, string]
    }
  } catch {
    // Ignore corrupt keys.
  }
  return null
}

// Sessions written since the last successful merge. Merge overlays only these
// keys instead of the whole in-memory maps, so a repeated rehydrate without
// new writes cannot resurrect stale entries. Entries survive a failed hydrate
// and are cleared only on successful merge.
const dirtyFlatSessions = new Set<string>()
const dirtyAgentModelKeys = new Set<string>()
const dirtyVariantKeys = new Set<string>()
let dirtyLastUsedProvider = false

const clearDirty = () => {
  dirtyFlatSessions.clear()
  dirtyAgentModelKeys.clear()
  dirtyVariantKeys.clear()
  dirtyLastUsedProvider = false
}

/** Test-only: drop in-memory dirty keys simulating a fresh process. */
export const __clearSelectionDirtyForTests = () => clearDirty()

const mruSet = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key)
  map.set(key, value)
}

const parseFlatMap = <T>(raw: unknown, isValue: (v: unknown) => v is T) => {
  const value = new Map<string, T>()
  if (raw === undefined) return { value, failed: false }
  if (!Array.isArray(raw)) return { value, failed: true }
  let failed = false
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) { failed = true; continue }
    const [k, v] = entry as [unknown, unknown]
    if (typeof k !== "string" || !isValue(v)) { failed = true; continue }
    value.set(k, v)
  }
  return { value, failed }
}

const parseAgentModelMap = (raw: unknown) => {
  const value = new Map<string, Map<string, ModelSelection>>()
  if (raw === undefined) return { value, failed: false }
  if (!Array.isArray(raw)) return { value, failed: true }
  let failed = false
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) { failed = true; continue }
    const [sessionId, agentArray] = entry as [unknown, unknown]
    if (typeof sessionId !== "string" || !Array.isArray(agentArray)) { failed = true; continue }
    const inner = parseFlatMap(agentArray, isModelSelection)
    if (inner.failed) failed = true
    if (inner.value.size > 0) value.set(sessionId, inner.value)
    else if (agentArray.length === 0) value.set(sessionId, inner.value)
  }
  return { value, failed }
}

const parseVariantMap = (raw: unknown) => {
  const value = new Map<string, Map<string, Map<string, string>>>()
  if (raw === undefined) return { value, failed: false }
  if (!Array.isArray(raw)) return { value, failed: true }
  let failed = false
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) { failed = true; continue }
    const [sessionId, agentArray] = entry as [unknown, unknown]
    if (typeof sessionId !== "string" || !Array.isArray(agentArray)) { failed = true; continue }
    const agentMap = new Map<string, Map<string, string>>()
    for (const agentEntry of agentArray) {
      if (!Array.isArray(agentEntry) || agentEntry.length !== 2) { failed = true; continue }
      const [agentName, modelArray] = agentEntry as [unknown, unknown]
      if (typeof agentName !== "string" || !Array.isArray(modelArray)) { failed = true; continue }
      const modelMap = parseFlatMap(modelArray, isString)
      if (modelMap.failed) failed = true
      if (modelMap.value.size > 0) agentMap.set(agentName, modelMap.value)
    }
    if (agentMap.size > 0) value.set(sessionId, agentMap)
  }
  return { value, failed }
}

export type LegacyContextSelections = {
  models: Map<string, ModelSelection>
  agents: Map<string, string>
  agentModels: Map<string, Map<string, ModelSelection>>
  variants: Map<string, Map<string, Map<string, string>>>
  currentAgentContext: Map<string, string>
}

export type LegacyParseResult = {
  status: "missing" | "ok" | "failed"
  data: LegacyContextSelections
  failed: boolean
}

const emptyLegacySelections = (): LegacyContextSelections => ({
  models: new Map(),
  agents: new Map(),
  agentModels: new Map(),
  variants: new Map(),
  currentAgentContext: new Map(),
})

/**
 * Parse a raw `context-store` disk payload without touching the stored key.
 * Missing (null) is distinct from malformed. Good slices survive malformed
 * siblings but report `failed` so the caller does not mark migration complete.
 * Array and primitive containers are malformed, never empty success.
 */
export const parseLegacyContextStorePayload = (raw: string | null): LegacyParseResult => {
  if (raw === null) {
    return { status: "missing", failed: false, data: emptyLegacySelections() }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: "failed", failed: true, data: emptyLegacySelections() }
  }
  if (!isRecord(parsed)) {
    return { status: "failed", failed: true, data: emptyLegacySelections() }
  }
  const envelope: unknown = "state" in parsed ? parsed.state : parsed
  if (!isRecord(envelope)) {
    return { status: "failed", failed: true, data: emptyLegacySelections() }
  }
  const models = parseFlatMap(envelope.sessionModelSelections ?? undefined, isModelSelection)
  const agents = parseFlatMap(envelope.sessionAgentSelections ?? undefined, isString)
  const agentModels = parseAgentModelMap(envelope.sessionAgentModelSelections ?? undefined)
  const variants = parseVariantMap(envelope.sessionAgentModelVariantSelections ?? undefined)
  const currentAgentContext = parseFlatMap(envelope.currentAgentContext ?? undefined, isString)
  const failed = models.failed || agents.failed || agentModels.failed || variants.failed || currentAgentContext.failed
  return {
    status: failed ? "failed" : "ok",
    failed,
    data: {
      models: models.value,
      agents: agents.value,
      agentModels: agentModels.value,
      variants: variants.value,
      currentAgentContext: currentAgentContext.value,
    },
  }
}

// Tri-state legacy read at this migration boundary only. The shared adapter
// swallows underlying failures into null, which would look like a missing key
// and incorrectly complete the migration. Prefer the raw key so failure stays
// distinct from missing without changing the adapter for other callers.
// Without a window (SSR/tests) fall back to the adapter; the test mock can
// still throw to exercise the failure path.
const readLegacyContextStore = (): LegacyParseResult => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return parseLegacyContextStorePayload(window.localStorage.getItem(LEGACY_CONTEXT_STORE_KEY))
    }
  } catch {
    return { status: "failed", failed: true, data: emptyLegacySelections() }
  }
  try {
    return parseLegacyContextStorePayload(getSafeStorage().getItem(LEGACY_CONTEXT_STORE_KEY))
  } catch {
    return { status: "failed", failed: true, data: emptyLegacySelections() }
  }
}

const removeVariantFromMap = (
  outer: Map<string, Map<string, Map<string, string>>>,
  sessionId: string,
  agentName: string,
  modelKey: string,
) => {
  const agentMap = outer.get(sessionId)
  const modelMap = agentMap?.get(agentName)
  if (!modelMap?.has(modelKey)) return false
  modelMap.delete(modelKey)
  if (modelMap.size === 0) agentMap?.delete(agentName)
  if (agentMap && agentMap.size === 0) outer.delete(sessionId)
  return true
}

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set, get) => ({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      sessionAgentModelVariantSelections: new Map(),
      lastUsedProvider: null,
      hasHydrated: typeof window === "undefined",
      contextStoreMigrationVersion: undefined,
      clearedVariantKeys: [],

      saveSessionModelSelection: (sessionId, providerId, modelId) => {
        dirtyFlatSessions.add(sessionId)
        dirtyLastUsedProvider = true
        set((s) => {
          const map = new Map(s.sessionModelSelections)
          map.delete(sessionId)
          map.set(sessionId, { providerId, modelId })
          return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }
        })
      },

      getSessionModelSelection: (sessionId) => get().sessionModelSelections.get(sessionId) ?? null,

      saveSessionAgentSelection: (sessionId, agentName) => {
        if (get().sessionAgentSelections.get(sessionId) === agentName) return
        dirtyFlatSessions.add(sessionId)
        set((s) => {
          if (s.sessionAgentSelections.get(sessionId) === agentName) return s
          const map = new Map(s.sessionAgentSelections)
          map.delete(sessionId)
          map.set(sessionId, agentName)
          return { sessionAgentSelections: map }
        })
      },

      getSessionAgentSelection: (sessionId) => get().sessionAgentSelections.get(sessionId) ?? null,

      saveAgentModelForSession: (sessionId, agentName, providerId, modelId) => {
        const existing = get().sessionAgentModelSelections.get(sessionId)?.get(agentName)
        if (existing?.providerId === providerId && existing?.modelId === modelId) return
        dirtyAgentModelKeys.add(buildAgentModelDirtyKey(sessionId, agentName))
        set((s) => {
          const current = s.sessionAgentModelSelections.get(sessionId)?.get(agentName)
          if (current?.providerId === providerId && current?.modelId === modelId) return s
          const outer = new Map(s.sessionAgentModelSelections)
          const inner = new Map(outer.get(sessionId) ?? new Map())
          outer.delete(sessionId)
          inner.set(agentName, { providerId, modelId })
          outer.set(sessionId, inner)
          return { sessionAgentModelSelections: outer }
        })
      },

      getAgentModelForSession: (sessionId, agentName) =>
        get().sessionAgentModelSelections.get(sessionId)?.get(agentName) ?? null,

      saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => {
        const modelKey = buildVariantModelKey(providerId, modelId)
        const tombstone = buildVariantTombstoneKey(sessionId, agentName, modelKey)
        if (variant === undefined) {
          const existing = get().sessionAgentModelVariantSelections.get(sessionId)?.get(agentName)?.get(modelKey)
          if (existing === undefined) {
            // Pre-hydration clear of a not-yet-loaded variant still records
            // intent: the incoming snapshot may contain it.
            if (!get().hasHydrated) {
              dirtyVariantKeys.add(tombstone)
              set((s) => {
                if (s.clearedVariantKeys.includes(tombstone)) return s
                return { clearedVariantKeys: [...s.clearedVariantKeys, tombstone] } as Partial<SelectionState>
              })
            }
            return
          }
          dirtyVariantKeys.add(tombstone)
          set((s) => {
            if (s.sessionAgentModelVariantSelections.get(sessionId)?.get(agentName)?.get(modelKey) === undefined) {
              return s
            }
            const outer = new Map(s.sessionAgentModelVariantSelections)
            const agentMap = new Map(outer.get(sessionId) ?? new Map())
            const modelMap = new Map(agentMap.get(agentName) ?? new Map())
            modelMap.delete(modelKey)
            if (modelMap.size === 0) agentMap.delete(agentName)
            else agentMap.set(agentName, modelMap)
            if (agentMap.size === 0) outer.delete(sessionId)
            else {
              outer.delete(sessionId)
              outer.set(sessionId, agentMap)
            }
            const tombstones = s.clearedVariantKeys.includes(tombstone)
              ? s.clearedVariantKeys
              : [...s.clearedVariantKeys, tombstone]
            return { sessionAgentModelVariantSelections: outer, clearedVariantKeys: tombstones }
          })
          return
        }
        if (get().sessionAgentModelVariantSelections.get(sessionId)?.get(agentName)?.get(modelKey) === variant) return
        dirtyVariantKeys.add(tombstone)
        set((s) => {
          if (s.sessionAgentModelVariantSelections.get(sessionId)?.get(agentName)?.get(modelKey) === variant) return s
          const outer = new Map(s.sessionAgentModelVariantSelections)
          const agentMap = new Map(outer.get(sessionId) ?? new Map())
          const modelMap = new Map(agentMap.get(agentName) ?? new Map())
          outer.delete(sessionId)
          modelMap.set(modelKey, variant)
          agentMap.set(agentName, modelMap)
          outer.set(sessionId, agentMap)
          return { sessionAgentModelVariantSelections: outer }
        })
      },

      getAgentModelVariantForSession: (sessionId, agentName, providerId, modelId) => {
        const key = buildVariantModelKey(providerId, modelId)
        return get().sessionAgentModelVariantSelections.get(sessionId)?.get(agentName)?.get(key)
      },
    }),
    {
      name: SELECTION_STORE_KEY,
      version: SELECTION_STORE_VERSION,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({
        sessionModelSelections: Array.from(state.sessionModelSelections.entries()),
        sessionAgentSelections: Array.from(state.sessionAgentSelections.entries()),
        sessionAgentModelSelections: Array.from(state.sessionAgentModelSelections.entries())
          .map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())]),
        sessionAgentModelVariantSelections: Array.from(state.sessionAgentModelVariantSelections.entries())
          .map(([sessionId, agentMap]) => [
            sessionId,
            Array.from(agentMap.entries()).map(([agentName, modelMap]) => [agentName, Array.from(modelMap.entries())]),
          ]),
        lastUsedProvider: state.lastUsedProvider,
        contextStoreMigrationVersion: state.contextStoreMigrationVersion,
        clearedVariantKeys: state.clearedVariantKeys,
      }),
      merge: (persistedState: unknown, currentState) => {
        // Malformed canonical roots are failure, not empty success. Missing
        // (undefined) is the only empty case; arrays and primitives fail.
        let canonicalFailed = false
        let persistedRecord: Record<string, unknown> | undefined
        if (persistedState === undefined) {
          persistedRecord = undefined
        } else if (!isRecord(persistedState)) {
          canonicalFailed = true
          persistedRecord = undefined
        } else {
          persistedRecord = persistedState
        }

        const canonicalModels = parseFlatMap(persistedRecord?.sessionModelSelections ?? undefined, isModelSelection)
        const canonicalAgents = parseFlatMap(persistedRecord?.sessionAgentSelections ?? undefined, isString)
        const canonicalAgentModels = parseAgentModelMap(persistedRecord?.sessionAgentModelSelections ?? undefined)
        const canonicalVariants = parseVariantMap(persistedRecord?.sessionAgentModelVariantSelections ?? undefined)
        if (persistedRecord !== undefined) {
          canonicalFailed = canonicalFailed
            || canonicalModels.failed || canonicalAgents.failed
            || canonicalAgentModels.failed || canonicalVariants.failed
        }
        let lastUsedProvider: LastUsedProvider | null = currentState.lastUsedProvider
        if (persistedRecord?.lastUsedProvider !== undefined) {
          const candidate = persistedRecord.lastUsedProvider as LastUsedProvider | null
          if (candidate === null || (isRecord(candidate)
            && typeof candidate.providerID === "string" && typeof candidate.modelID === "string")) {
            lastUsedProvider = candidate
          } else {
            canonicalFailed = true
          }
        }
        let persistedTombstones: string[] = []
        if (persistedRecord?.clearedVariantKeys !== undefined) {
          const raw = persistedRecord.clearedVariantKeys
          if (Array.isArray(raw) && raw.every(isString)) {
            persistedTombstones = [...raw]
          } else {
            canonicalFailed = true
          }
        }

        const alreadyMigrated = persistedRecord?.contextStoreMigrationVersion === CONTEXT_STORE_MIGRATION_VERSION
        const legacy = alreadyMigrated
          ? { status: "missing" as const, failed: false, data: emptyLegacySelections() }
          : readLegacyContextStore()
        const legacyFailed = legacy.failed

        // Start from canonical, fill gaps from legacy (canonical wins).
        const models = new Map(canonicalModels.value)
        const agents = new Map(canonicalAgents.value)
        const agentModels = new Map<string, Map<string, ModelSelection>>(
          Array.from(canonicalAgentModels.value.entries()).map(([k, v]) => [k, new Map(v)]),
        )
        const variants = new Map<string, Map<string, Map<string, string>>>(
          Array.from(canonicalVariants.value.entries()).map(([k, v]) => [k, new Map(Array.from(v.entries()).map(([ak, mv]) => [ak, new Map(mv)]))]),
        )
        const tombstones = new Set<string>([
          ...persistedTombstones,
          ...currentState.clearedVariantKeys,
        ])

        if (legacy.status === "ok" || legacy.status === "failed") {
          const data = legacy.data
          for (const [sessionId, selection] of data.models) {
            if (!models.has(sessionId)) models.set(sessionId, selection)
          }
          for (const [sessionId, agent] of data.agents) {
            if (!agents.has(sessionId)) agents.set(sessionId, agent)
          }
          // Legacy currentAgentContext backs sessions with no agent selection.
          for (const [sessionId, agent] of data.currentAgentContext) {
            if (!agents.has(sessionId)) agents.set(sessionId, agent)
          }
          for (const [sessionId, agentMap] of data.agentModels) {
            let target = agentModels.get(sessionId)
            if (!target) {
              target = new Map()
              agentModels.set(sessionId, target)
            }
            for (const [agentName, selection] of agentMap) {
              if (!target.has(agentName)) target.set(agentName, selection)
            }
          }
          for (const [sessionId, agentMap] of data.variants) {
            for (const [agentName, modelMap] of agentMap) {
              for (const [modelKey, variant] of modelMap) {
                if (tombstones.has(buildVariantTombstoneKey(sessionId, agentName, modelKey))) continue
                let sessionMap = variants.get(sessionId)
                if (!sessionMap) {
                  sessionMap = new Map()
                  variants.set(sessionId, sessionMap)
                }
                let agentVariantMap = sessionMap.get(agentName)
                if (!agentVariantMap) {
                  agentVariantMap = new Map()
                  sessionMap.set(agentName, agentVariantMap)
                }
                if (!agentVariantMap.has(modelKey)) agentVariantMap.set(modelKey, variant)
              }
            }
          }
        }

        // Overlay only sessions actually written since the last successful
        // merge. A repeated rehydrate with no new writes overlays nothing.
        for (const sessionId of dirtyFlatSessions) {
          const model = currentState.sessionModelSelections.get(sessionId)
          if (model) mruSet(models, sessionId, model)
          const agent = currentState.sessionAgentSelections.get(sessionId)
          if (agent !== undefined) mruSet(agents, sessionId, agent)
        }
        for (const key of dirtyAgentModelKeys) {
          const parsed = parseAgentModelDirtyKey(key)
          if (!parsed) continue
          const [sessionId, agentName] = parsed
          const selection = currentState.sessionAgentModelSelections.get(sessionId)?.get(agentName)
          if (!selection) continue
          let target = agentModels.get(sessionId)
          if (!target) {
            target = new Map()
            agentModels.set(sessionId, target)
          }
          target.set(agentName, selection)
          agentModels.delete(sessionId)
          agentModels.set(sessionId, target)
        }
        for (const key of dirtyVariantKeys) {
          const parsed = parseTombstoneKey(key)
          if (!parsed) continue
          const [sessionId, agentName, modelKey] = parsed
          const live = currentState.sessionAgentModelVariantSelections.get(sessionId)?.get(agentName)?.get(modelKey)
          if (live !== undefined) {
            let sessionMap = variants.get(sessionId)
            if (!sessionMap) {
              sessionMap = new Map()
              variants.set(sessionId, sessionMap)
            }
            let agentVariantMap = sessionMap.get(agentName)
            if (!agentVariantMap) {
              agentVariantMap = new Map()
              sessionMap.set(agentName, agentVariantMap)
            }
            agentVariantMap.set(modelKey, live)
          } else {
            removeVariantFromMap(variants, sessionId, agentName, modelKey)
          }
        }
        if (dirtyLastUsedProvider && currentState.lastUsedProvider !== null) {
          lastUsedProvider = currentState.lastUsedProvider
        }

        const migrationComplete = alreadyMigrated || (!canonicalFailed && !legacyFailed)
        clearDirty()

        return {
          ...currentState,
          sessionModelSelections: models,
          sessionAgentSelections: agents,
          sessionAgentModelSelections: agentModels,
          sessionAgentModelVariantSelections: variants,
          lastUsedProvider,
          hasHydrated: true,
          clearedVariantKeys: migrationComplete ? [] : Array.from(tombstones),
          contextStoreMigrationVersion: migrationComplete ? CONTEXT_STORE_MIGRATION_VERSION : currentState.contextStoreMigrationVersion,
        }
      },
      migrate: (persistedState: unknown) => persistedState,
    }
  )
)

// Open the composer gate once the first successful hydration commits. A
// rejected hydrate never reaches here, so the gate stays closed and the
// in-memory intent plus dirty keys survive for the next retry.
if (typeof window !== "undefined") {
  const persistApi = (
    useSelectionStore as unknown as {
      persist?: {
        hasHydrated?: () => boolean
        onFinishHydration?: (cb: () => void) => (() => void) | void
      }
    }
  ).persist

  const markHydrated = () => {
    if (!useSelectionStore.getState().hasHydrated) {
      useSelectionStore.setState({ hasHydrated: true })
    }
  }

  if (persistApi?.hasHydrated?.()) {
    markHydrated()
  } else if (persistApi?.onFinishHydration) {
    persistApi.onFinishHydration(markHydrated)
  } else {
    markHydrated()
  }
}
