import { describe, expect, test } from "bun:test"
import {
  compareModelRefs,
  findModel,
  findProvider,
  flattenProviderModels,
  isThinkingAllowed,
  listProviderModels,
  modelRefKey,
  pickFallbackThinking,
  resolveNewSessionModel,
  resolveNewSessionThinking,
} from "./model-provider"
import type { PiModel, PiProvider } from "./types"

const provider = (id: string, models: PiModel[]): PiProvider => ({
  id,
  label: id.toUpperCase(),
  authenticated: true,
  models,
})

const model = (id: string, providerId: string, opts: Partial<PiModel> = {}): PiModel => ({
  id,
  providerId,
  ...opts,
})

describe("compareModelRefs / modelRefKey", () => {
  test("compares both fields", () => {
    expect(compareModelRefs({ providerId: "p", modelId: "m" }, { providerId: "p", modelId: "m" })).toBe(true)
    expect(compareModelRefs({ providerId: "p", modelId: "m" }, { providerId: "p", modelId: "x" })).toBe(false)
    expect(compareModelRefs(undefined, undefined)).toBe(false)
  })

  test("builds a stable key", () => {
    expect(modelRefKey({ providerId: "p", modelId: "m" })).toBe("p/m")
    expect(modelRefKey(undefined)).toBe(undefined)
  })
})

describe("listProviderModels / flattenProviderModels", () => {
  test("sorts models by id", () => {
    const p = provider("p", [model("z", "p"), model("a", "p"), model("m", "p")])
    expect(listProviderModels(p).map((m) => m.id)).toEqual(["a", "m", "z"])
  })

  test("flattens with provider ordering preserved", () => {
    const providers = [
      provider("b", [model("b1", "b"), model("b2", "b")]),
      provider("a", [model("a1", "a")]),
    ]
    const flat = flattenProviderModels(providers)
    // providers sorted by label "A" before "B"
    expect(flat.map((m) => m.id)).toEqual(["a1", "b1", "b2"])
  })
})

describe("findProvider / findModel", () => {
  const providers = [
    provider("p1", [model("m1", "p1"), model("m2", "p1")]),
    provider("p2", [model("m3", "p2")]),
  ]

  test("findProvider returns the provider by id", () => {
    expect(findProvider(providers, "p1")?.id).toBe("p1")
    expect(findProvider(providers, "missing")).toBe(undefined)
  })

  test("findModel locates a model across providers", () => {
    expect(findModel(providers, "p2", "m3")?.id).toBe("m3")
    expect(findModel(providers, "p1", "missing")).toBe(undefined)
  })
})

describe("isThinkingAllowed / pickFallbackThinking", () => {
  const explicit = model("m", "p", { supportsThinking: true, thinkingLevels: ["low", "high"] })
  const unrestricted = model("u", "p")
  const disallowed = model("d", "p", { supportsThinking: false })

  test("allows off by default", () => {
    expect(isThinkingAllowed(explicit, "off")).toBe(true)
  })

  test("respects explicit allow list", () => {
    expect(isThinkingAllowed(explicit, "low")).toBe(true)
    expect(isThinkingAllowed(explicit, "medium")).toBe(false)
  })

  test("allows thinking when no list is provided", () => {
    expect(isThinkingAllowed(unrestricted, "medium")).toBe(true)
  })

  test("denies unsupported models", () => {
    expect(isThinkingAllowed(disallowed, "low")).toBe(false)
  })

  test("pickFallbackThinking chooses the closest allowed level", () => {
    // `explicit` allows low/high only, so xhigh falls back to the default order.
    expect(pickFallbackThinking(explicit, "xhigh")).toBe("low")
    // `unrestricted` has no thinking levels, so it allows xhigh.
    expect(pickFallbackThinking(unrestricted, "xhigh")).toBe("xhigh")
    // `disallowed` does not support thinking at all, so the fallback is `off`.
    expect(pickFallbackThinking(disallowed, "low")).toBe("off")
  })
})

describe("resolveNewSessionModel", () => {
  const providers = [
    provider("p1", [model("m1", "p1"), model("m2", "p1")]),
  ]

  test("explicit beats configured default beats Pi fallback", () => {
    const result = resolveNewSessionModel({
      providers,
      explicit: { providerId: "p1", modelId: "m2" },
      configuredDefault: { providerId: "p1", modelId: "m1" },
      piFallback: { providerId: "p1", modelId: "m1" },
    })
    expect(result).toEqual({ providerId: "p1", modelId: "m2" })
  })

  test("returns Pi fallback when no defaults are configured", () => {
    const result = resolveNewSessionModel({
      providers,
      piFallback: { providerId: "p1", modelId: "m1" },
    })
    expect(result).toEqual({ providerId: "p1", modelId: "m1" })
  })

  test("falls back when explicit is unknown", () => {
    const result = resolveNewSessionModel({
      providers,
      explicit: { providerId: "ghost", modelId: "x" },
      piFallback: { providerId: "p1", modelId: "m1" },
    })
    expect(result).toEqual({ providerId: "p1", modelId: "m1" })
  })

  test("preserves an unknown explicit choice when no fallback is configured", () => {
    const result = resolveNewSessionModel({
      providers,
      explicit: { providerId: "ghost", modelId: "x" },
    })
    expect(result).toEqual({ providerId: "ghost", modelId: "x" })
  })
})

describe("resolveNewSessionThinking", () => {
  const providers = [
    provider("p", [model("m", "p", { supportsThinking: true, thinkingLevels: ["low", "medium"] })]),
  ]

  test("explicit overrides configured default and Pi fallback", () => {
    const result = resolveNewSessionThinking({
      providers,
      resolvedModel: { providerId: "p", modelId: "m" },
      explicit: "low",
      configuredDefault: "high",
      piFallback: "medium",
    })
    expect(result).toBe("low")
  })

  test("falls back to a permitted level when explicit is unsupported", () => {
    const result = resolveNewSessionThinking({
      providers,
      resolvedModel: { providerId: "p", modelId: "m" },
      explicit: "high",
    })
    expect(result).toBe("medium")
  })

  test("preserves off when explicit is off", () => {
    const result = resolveNewSessionThinking({
      providers,
      resolvedModel: { providerId: "p", modelId: "m" },
      explicit: "off",
    })
    expect(result).toBe("off")
  })
})
