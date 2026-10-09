/**
 * Network-request volume measurement for the idle profiler.
 *
 * `profile:idle` historically reported CPU, style/layout, DOM, and heap work
 * while nobody interacts with the app, but not the repeating fetches that keep
 * the tab busy (`/api/git/worktrees`, `/api/git/check`, ...). This module owns the CDP `Network.requestWillBeSent` plumbing behind
 * that gap so `profile-idle.mjs` stays a thin orchestrator.
 *
 * Privacy rule: query string VALUES are never stored or printed because they
 * contain local paths and pairing tokens. Only the pathname and the sorted
 * unique query parameter NAMES are kept (e.g. `/api/git/check{?directory}`).
 */

export const API_PATH_PREFIX = "/api/"

/**
 * Canonical context-panel modes the `--cycle-panels` switcher understands.
 * `files` is accepted as an alias for the `file` tab mode; `diff` resolves to
 * the git rail surface, matching `openContextSurface` in useUIStore.
 */
const CYCLE_MODE_ALIASES = {
  files: "file",
  file: "file",
  git: "git",
  diff: "git",
  terminal: "terminal",
  context: "context",
  browser: "browser",
  preview: "preview",
  "pull-requests": "pull-requests",
  pr: "pull-requests",
  issues: "issues",
}

export const KNOWN_CYCLE_MODES = [...new Set(Object.values(CYCLE_MODE_ALIASES))]

export const normalizeCycleMode = (raw) => {
  const key = String(raw ?? "").trim().toLowerCase()
  const canonical = CYCLE_MODE_ALIASES[key]
  if (!canonical) {
    throw new Error(
      `--cycle-panels mode ${JSON.stringify(String(raw))} is unknown.`
      + ` Expected one of: ${[...Object.keys(CYCLE_MODE_ALIASES)].sort().join(", ")}`,
    )
  }
  return canonical
}

/**
 * Accessible rail labels for each canonical cycle mode. The git surface reads
 * "Changes" outside a repository and its aria-label gains a
 * ", N changed files" suffix when dirty, so matching is prefix-based in the
 * page script rather than exact.
 */
export const RAIL_LABELS_FOR_MODE = {
  git: ["Git", "Changes"],
  terminal: ["Terminal"],
  file: ["Files"],
  context: ["Context"],
  browser: ["Browser"],
  preview: ["Preview"],
  "pull-requests": ["Pull requests"],
  issues: ["Issues"],
}

/**
 * Splits a raw request URL into a report-safe pathname plus sorted unique
 * query parameter names. Values are dropped unconditionally. Non-hierarchical
 * URLs (data:, blob:, about:) have no pathname and report as-is without a
 * query section.
 */
export const sanitizeRequestUrl = (rawUrl) => {
  const text = String(rawUrl ?? "")
  try {
    const parsed = new URL(text, "http://localhost")
    const pathname = parsed.pathname || "/"
    const names = new Set()
    for (const name of parsed.searchParams.keys()) names.add(name)
    return { pathname, queryParamNames: [...names].sort(), search: parsed.search }
  } catch {
    const bare = text.split("?")[0] || "(unknown)"
    return { pathname: bare.slice(0, 200) || "(unknown)", queryParamNames: [], search: "" }
  }
}

export const isApiPathname = (pathname) => String(pathname ?? "").startsWith(API_PATH_PREFIX)

/**
 * Builds the stored network event for one CDP `requestWillBeSent`. Runs on
 * every request, so it stays allocation-light and never throws: an
 * unparseable dispatch still counts toward the liveness proof.
 */
export const toNetworkEvent = (params, receivedAt) => {
  const { pathname, queryParamNames, search } = sanitizeRequestUrl(params?.request?.url)
  const method = String(params?.request?.method ?? "GET").toUpperCase()
  const type = String(params?.type ?? "")
  return {
    receivedAt,
    method,
    pathname,
    queryParamNames,
    // In-memory only: used to count distinct URLs per endpoint so repeated
    // identical requests are distinguishable from per-directory fan-out.
    // Never serialized or printed (values contain local paths).
    search,
    isApi: isApiPathname(pathname),
    isSse: type === "EventSource",
    type,
  }
}

const groupKey = (method, pathname) => `${method} ${pathname}`

const perMinute = (count, durationSeconds) =>
  durationSeconds > 0 ? Number(((count / durationSeconds) * 60).toFixed(1)) : 0

/**
 * Summarizes one attribution window [startMs, endMs). Pure over the recorded
 * event lists so the settle, idle, and per-switch windows share one code path.
 */
export const summarizeNetworkWindow = (events, wsOpenedAt, startMs, endMs) => {
  const durationSeconds = Math.max(0, (endMs - startMs) / 1000)
  const inWindow = events.filter((event) => event.receivedAt >= startMs && event.receivedAt < endMs)
  const api = inWindow.filter((event) => event.isApi)
  const groups = new Map()
  for (const event of api) {
    const key = groupKey(event.method, event.pathname)
    const entry = groups.get(key) ?? {
      key,
      method: event.method,
      pathname: event.pathname,
      queryParamNames: new Set(),
      searches: new Set(),
      count: 0,
    }
    entry.count += 1
    entry.searches.add(event.search ?? "")
    for (const name of event.queryParamNames) entry.queryParamNames.add(name)
    groups.set(key, entry)
  }
  const grouped = [...groups.values()]
    .sort((left, right) => right.count - left.count || (left.key < right.key ? -1 : 1))
    .map((entry) => ({
      key: entry.key,
      method: entry.method,
      pathname: entry.pathname,
      queryParamNames: [...entry.queryParamNames].sort(),
      count: entry.count,
      distinct: entry.searches.size,
      perMinute: perMinute(entry.count, durationSeconds),
    }))
  return {
    durationSeconds: Number(durationSeconds.toFixed(2)),
    totalApi: api.length,
    apiPerMinute: perMinute(api.length, durationSeconds),
    totalStatic: inWindow.length - api.length,
    totalRequests: inWindow.length,
    wsOpened: wsOpenedAt.filter((at) => at >= startMs && at < endMs).length,
    sseOpened: inWindow.filter((event) => event.isSse).length,
    grouped,
  }
}

/**
 * Page-side rail switch: clicks the right-rail button for `mode` unless it is
 * already active (the rail toggles the panel closed when the active surface is
 * re-selected, so clicking unconditionally would close the panel on repeats).
 * Returns a JSON string because `Runtime.evaluate` with `returnByValue`
 * transports plain values most reliably.
 */
export const buildRailSwitchExpression = (mode) => `(() => {
  const labels = ${JSON.stringify(RAIL_LABELS_FOR_MODE[mode] ?? [mode])}.map((label) => label.toLowerCase())
  const nav = document.querySelector('nav[aria-label="Panel surfaces"]')
  if (!nav) return JSON.stringify({ ok: false, reason: "rail-missing" })
  const buttons = [...nav.querySelectorAll("button")]
  const match = buttons.find((button) => {
    const label = (button.getAttribute("aria-label") ?? "").toLowerCase()
    return labels.some((want) => label === want || label.startsWith(want + ",") || label.startsWith(want + " "))
  })
  if (!match) {
    return JSON.stringify({
      ok: false,
      reason: "button-missing",
      available: buttons.map((button) => button.getAttribute("aria-label") ?? ""),
    })
  }
  const alreadyActive = match.getAttribute("aria-pressed") === "true"
  if (!alreadyActive) match.click()
  return JSON.stringify({ ok: true, clicked: !alreadyActive, label: match.getAttribute("aria-label") ?? "" })
})()`

/**
 * Independent DOM verification that the switch landed: the rail button reports
 * pressed AND the context panel is laid out open. The header slot for some
 * surfaces (terminal, git) is portal-driven, so the header text is reported
 * for diagnostics but is not part of the pass/fail signal.
 */
export const buildRailVerifyExpression = (mode) => `(() => {
  const labels = ${JSON.stringify(RAIL_LABELS_FOR_MODE[mode] ?? [mode])}.map((label) => label.toLowerCase())
  const nav = document.querySelector('nav[aria-label="Panel surfaces"]')
  const buttons = nav ? [...nav.querySelectorAll("button")] : []
  const match = buttons.find((button) => {
    const label = (button.getAttribute("aria-label") ?? "").toLowerCase()
    return labels.some((want) => label === want || label.startsWith(want + ",") || label.startsWith(want + " "))
  })
  const pressed = match ? match.getAttribute("aria-pressed") === "true" : false
  const panel = document.querySelector('aside[data-context-panel="true"]')
  const rectWidth = panel ? panel.getBoundingClientRect().width : 0
  const panelOpen = Boolean(panel) && !panel.hasAttribute("inert") && rectWidth > 10
  return JSON.stringify({
    pressed,
    panelOpen,
    panelWidth: Math.round(rectWidth),
    railLabel: match ? (match.getAttribute("aria-label") ?? "") : null,
    headerText: (panel ? panel.querySelector("header")?.innerText ?? "" : "").slice(0, 120),
  })
})()`
