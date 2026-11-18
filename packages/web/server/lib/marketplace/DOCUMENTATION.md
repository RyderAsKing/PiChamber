# Marketplace (server)

## Purpose

Lets Settings find and install Pi packages without a registry of our own.
Pi packages are npm packages with the `pi-package` keyword, the same list
pi.dev's package gallery shows. This module reads npm's public search and
package endpoints, adds a curated featured list from the PiChamber repo, and
answers the UI through `/api/pi/marketplace/*`. Installing is not here: it
is a Pi package-manager write owned by the session daemon
(`../pi/session-daemon/extension-config.js`, `POST /api/pi/extensions/packages`).

## Entrypoints

- `npm-registry.js` is the only code that talks to npm.
  `createNpmRegistry({ fetchImpl, registryUrl, downloadsUrl, timeoutMs })`
  returns `searchRaw`, `latest(name)` and `weeklyDownloads(name)`. Responses
  are size-capped (search 2 MB, manifest 512 KB) and time out after 8 s.
  Failures are `MarketplaceError` with code `MARKETPLACE_UNAVAILABLE` or
  `MARKETPLACE_PACKAGE_NOT_FOUND`. `summarizePackage` and `summarizeManifest`
  reduce npm's answers to the fields the UI shows. Links pass `safeLink`
  (http/https only). Requests carry the generic user agent `PiChamber` and
  nothing about the user.
- `featured.js` owns the featured list. The built-in copy is
  `packages/web/plugins/featured.json`; the remote copy is the same file on
  the repo's `main` branch (`DEFAULT_FEATURED_URL`), refreshed at most every
  6 hours (10 minutes after a failure), capped at 64 KB, and cached at
  `<dataDir>/pi/featured.json` as `{ fetchedAt, list }`. `get()` never waits
  on the network: it answers with the newer of the cached and built-in lists
  (by `updated`; on the same date the cached copy wins) and starts a refresh
  in the background when one is due.
- `service.js` combines them with in-memory TTL caches (search 5 minutes,
  package and downloads 10 minutes, 300 entries, shared in-flight requests,
  failures not kept).
- `routes.js` registers the routes below. `server/index.js` builds the
  registry, featured source and service.

## List format

`featured.json`: `{ version: 1, updated: 'YYYY-MM-DD', featured: [{ name,
note? }], hidden: [name] }`. At most 24 featured entries with notes of at
most 120 characters, and 500 hidden names. Invalid names are dropped.
`hidden` is moderation: a hidden package is left out of search, featured and
package answers. Editing the file on `main` reaches every server within 6
hours; a release carries the file as the fallback.

## Routes

- `GET /api/pi/marketplace/search?q=&from=&pichamber=1` →
  `{ packages, total?, nextFrom }`. Pages of 20. `total` only without a
  query (npm's count for the keyword).
- `GET /api/pi/marketplace/featured` → `{ packages, updated, source }`, in
  the list's order. An entry npm cannot answer for comes back as
  `{ name, note, unavailable: true }` rather than failing the list.
- `GET /api/pi/marketplace/package?name=` → the package summary plus
  `license?`, `contains` (from its `pi` block), `pichamber` (its manifest
  declares a `pichamber` block with a numeric `apiVersion`) and `isPiPackage`.
- `GET /api/pi/marketplace/versions?names=a,b` → `{ versions: { name:
  version } }` for at most 50 names. Names npm cannot answer for are left out.
- Errors: 400 `INVALID_MARKETPLACE_REQUEST`, 404
  `MARKETPLACE_PACKAGE_NOT_FOUND`, 502 `MARKETPLACE_UNAVAILABLE`. A failed
  npm call is an error, never an empty list.

## Invariants

- npm search text only ranks; it does not filter. A query for nonsense
  returns popular packages that match nothing. The service keeps only hits
  where a query word appears in the name, description or keywords, and stops
  paging at the first page that has an unrelated hit, so the tail of
  unrelated packages never shows.
- npm treats two keywords loosely, so the service asks for one
  (`pichamber-plugin` with `pichamber=1`, otherwise `pi-package`) and checks
  both itself.
- The `pichamber-plugin` keyword is a claim by the author: it marks a list
  row. The package page reads the manifest and calls it a PiChamber plugin only
  when the `pichamber` block is really there. A third-party package with
  that block installs and runs as a plain Pi package; PiChamber does not load
  its UI half.
- The bundled plugins (`pluginService.bundledPackageNames()`) and hidden
  names never appear in an answer. The UI suggests the bundled plugin
  instead when a search matches it.
- No README, images or other package content are fetched: only npm's
  metadata, which is shown as text.

## Configuration

- `PICHAMBER_NPM_REGISTRY_URL` and `PICHAMBER_NPM_DOWNLOADS_URL` point at
  another registry (tests, mirrors).
- `PICHAMBER_FEATURED_URL` replaces the remote featured list; `off` turns the
  refresh off so only the built-in copy is used.

## Tests

`*.test.js` beside each file (vitest), with a fake `fetchImpl`; nothing
reaches the network.
