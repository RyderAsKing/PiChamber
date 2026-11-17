# Settings: "Extensions & Plugins" with `pi config`, `pi list`, and `pi remove`

Status: research (2026-11-17). The owner approved every recommendation in C7
the same day and the build started on `pichamber/plugin-ecosystem-sdk`.

## The question

Settings has a Plugins page for PiChamber's bundled plugins. The owner wants
to rename it to "Extensions & Plugins" and let it do what three Pi commands do:

- `pi list`: show user and project packages.
- `pi config`: turn each discovered resource on or off, per scope (global or
  project), including Pi's built-in extensions.
- `pi remove`: remove an installed package.

A marketplace (find and install) comes later. This note says how Pi does
each part, what PiChamber has today, and a design split into tickets.

## Sources and abbreviations

- `SDK/` means
  `node_modules/.bun/@earendil-works+pi-coding-agent@1.5.0+6eea108e771ad856/node_modules/@earendil-works/pi-coding-agent/`.
- `packages/web/package.json:36` pins `@earendil-works/pi-coding-agent` to
  `1.5.0`. The installed CLI on this machine is 1.5.2. Its changelog for 1.5.1
  and 1.5.2 (`/root/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`,
  sections `[1.5.2]` and `[1.5.1]`) changes `pi update` output and fixes
  `pi config` keybindings. Nothing in it changes how `config`, `list`, or
  `remove` read or write settings. The code below is read from 1.5.0.
- `daemon.js` means `packages/web/server/lib/pi/session-daemon/session-daemon.js`.
- `DAEMON-DOC` means `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`.

## A. How Pi does it

### A1. Where the commands live

All three commands are in `SDK/dist/package-manager-cli.js`.

| Command | Entry | Calls |
|---|---|---|
| `pi config` | `handleConfigCommand` (`package-manager-cli.js:742`) | `createCommandSettingsManager` (:704) for trust, `new DefaultPackageManager(...).resolve()` twice (:795, :802), then `selectConfig` (:808) in `SDK/dist/cli/config-selector.js:7`, which mounts `ConfigSelectorComponent` from `SDK/dist/modes/interactive/components/config-selector.js` |
| `pi list` | `handlePackageCommand` case `"list"` (:912) | `packageManager.listConfiguredPackages()` (`SDK/dist/core/package-manager.js:786`) |
| `pi remove` / `pi uninstall` | `parsePackageCommand` maps `uninstall` to `remove` (:334); case `"remove"` (:902) | `packageManager.removeAndPersist(source, { local })` (`package-manager.js:856`), which calls `remove()` (:837) then `removeSourceFromSettings()` (:682) |
| `pi install` | case `"install"` (:898) | `installAndPersist()` (`package-manager.js:833`): `install()` then `addSourceToSettings()` (:651) |

Settings go through `SettingsManager` (`SDK/dist/core/settings-manager.js`).
Trust goes through `ProjectTrustStore` and `resolveProjectTrusted`
(`createCommandSettingsManager`, `package-manager-cli.js:704-741`).

### A2. What they read and write

Settings files: `~/.pi/agent/settings.json` (user) and `.pi/settings.json`
(project). Resource keys are `packages`, `extensions`, `skills`, `prompts`,
`themes` (`SDK/docs/settings.md`, "Resources"). User paths resolve from the
agent dir; project paths from the project `.pi` dir (same section).

Filter entries (`SDK/docs/settings.md`, "Resources"; `SDK/docs/packages.md`,
"Select package resources"):

- `!pattern`: glob exclusion.
- `+path`: exact inclusion.
- `-path`: exact exclusion.
- Package object form: `{ source, extensions?, skills?, prompts?, themes? }`.
  Omitted key loads everything the package declares; `[]` loads none of
  that type. Filters only narrow the package manifest.
- `autoload: false` on a project package entry makes it a filtering delta
  over the user entry instead of a replacement (`SDK/docs/packages.md`,
  "Understand scope and identity").
- Built-ins: `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`,
  `builtin:tool-search`. They load by default; `-builtin:<name>` in
  `extensions` turns one off; a `+`/`-` entry in project settings overrides the
  user setting (`SDK/docs/settings.md`, "Resources";
  `package-manager.js:763-773`).

Package identity: npm by name, git by repo URL without ref, local by resolved
absolute path (`SDK/docs/packages.md`, "Understand scope and identity").

`pi list` reads both settings files and, per entry, returns
`{ source, scope: "user" | "project", filtered: <entry is object form>, installedPath }`
(`package-manager.js:786-809`). It writes nothing.

`pi remove` on disk (`package-manager.js:837-858`):

- npm: `uninstallNpm` (:1615) runs `npm uninstall <name> --prefix <root>`
  (or `bun uninstall --cwd`) in `<agentDir>/npm` for user scope or
  `<cwd>/.pi/npm` for project scope (`getNpmInstallRoot`, :1837).
- git: `removeGit` (:1787) does `rmSync(targetDir, { recursive: true })`,
  removes the update marker, and prunes empty parent dirs.
- local: deletes nothing; only the settings entry goes.
- Then `removeSourceFromSettings` filters every matching entry (by identity)
  out of that scope's `packages` and writes it (:682-697). It returns `false`
  if nothing matched, and the CLI prints "No matching package found" (:904).
- `remove()` calls `assertProjectTrustedForScope` for project scope (:840).

Note the order: files are removed before the settings entry. If settings
writing then fails, the entry points at a missing package; the next `resolve()`
would reinstall it (see A4 on `onMissing`).

### A3. What `pi config` shows and writes

Groups are built by `buildGroups` (`config-selector.js:41-117`). One group per
`origin:scope:source:baseDir`, with subgroups per resource type (extensions,
skills, prompts, themes; :93-96). Labels (`getGroupLabel`, :23-40):

- package: `<source> (user|project)`;
- built-in: `Built-in` or `Built-in (project override)`;
- auto-discovered: `User (~/.pi/agent/)` or `Project (.pi/)`;
- settings-listed paths: `User settings` / `Project settings`.

Packages sort first, then top-level; user before project (:98-108).

Toggle mapping:

- Global scope, top-level resource (`toggleTopLevelResource`, :413-461):
  remove any `!`/`+`/`-` entry for the resource's pattern, then push
  `+pattern` or `-pattern`. Pattern is the path relative to the base dir, or
  `builtin:<name>` for built-ins (`getResourcePattern`, :695-701). Written with
  `setExtensionPaths` / `setSkillPaths` / ... or the `setProject*` variants.
- Global scope, package resource (`togglePackageResource`, :462-508): convert
  the package entry to object form, push `+pattern`/`-pattern` (relative to
  the package root) into its per-type array, collapse back to a string when
  no filters remain, then `setPackages` / `setProjectPackages`.
- Project scope (`writeScope === "project"`): each item cycles
  inherit / load / unload (`getNextOverrideState`, :594-602). Top-level items
  write to project arrays; an inherited global file is named by its path
  first, then `+`/`-` (`setProjectTopLevelOverride`, :540-558). Package items
  get a project package entry, created if missing (`createPackageOverrideSource`),
  and an emptied `autoload: false` entry is removed (:569-593).
- In global scope only user-scope items toggle (:384).

Scope: Tab switches (`tui.input.tab`, :378), only when the project is trusted
(`projectModeAvailable`, :133). `-l` starts in project scope
(`handleConfigCommand`, :813). Project mode shows the user groups dimmed as
"inherited global" (:309-318).

Trust: `--approve` / `--no-approve` set an override (:757-761). Without one,
`createCommandSettingsManager` uses the saved `ProjectTrustStore` decision,
and may ask through project-trust extensions (:704-741). `-l` without trust
fails: "Project is not trusted. Use --approve ..." (:785-788). When not
trusted, the project view reuses the global resolve (:801-803).

### A4. What the SDK exports

`SDK/package.json` `exports` has only `.` and `./rpc-entry`. From
`SDK/dist/index.d.ts`:

| Needed | Exported? | Where |
|---|---|---|
| `DefaultPackageManager` (resolve, listConfiguredPackages, removeAndPersist, installAndPersist, add/removeSourceToSettings) | yes | `index.d.ts:17`; methods `SDK/dist/core/package-manager.d.ts:87-121` |
| `ResolvedPaths`, `ResolvedResource`, `PathMetadata` types | yes | `index.d.ts:16` |
| `SettingsManager` (with `setExtensionPaths`, `setPackages`, project variants, `flush`, `reload`) | yes | `index.d.ts:22`; `settings-manager.d.ts:64-195` |
| `ProjectTrustStore`, `hasTrustRequiringProjectResources` | yes | `index.d.ts:28` |
| `DefaultResourceLoader` | yes | `index.d.ts:19` |
| `getAgentDir`, `CONFIG_DIR_NAME` | yes | `index.d.ts:2` |
| `BUILTIN_PATH_PREFIX` | no | only `SDK/dist/core/source-info.d.ts:18` |
| Toggle logic (`toggleTopLevelResource`, project override cycle, pattern helpers) | no | private methods of `ConfigSelectorComponent` |
| `handleConfigCommand` / `handlePackageCommand` | no | `package-manager-cli.js`, not in index |

So listing and removal can run in-process. The toggle write cannot be
called; options:

1. Reimplement the write in a PiChamber module, using the exported
   `SettingsManager` setters (recommended; about 150 lines of pure logic,
   unit-testable against Pi's documented filter rules).
2. Deep import `dist/modes/interactive/components/config-selector.js`: blocked
   by `exports`, and the logic sits in a TUI class.
3. Shell out to `pi config`: interactive only, no flags for a single toggle.
4. Ask upstream to export a headless "set resource enabled" helper. Worth a
   request, but not a blocker.

`BUILTIN_PATH_PREFIX` is just `"builtin:"`; a local constant is fine, with a
test that pins it.

Caution: `resolve()` with no `onMissing` installs missing packages
(`package-manager.js:1068-1090`). A listing call must pass
`onMissing: () => "skip"` so opening Settings never runs npm or git.

### A5. How a running session picks up a change

`AgentSession.reload()` (`SDK/dist/core/agent-session.js:3016-3046`) emits
`session_shutdown` with reason `reload`, reloads `SettingsManager`, reloads the
resource loader, rebuilds the runtime, and emits `session_start` with reason
`reload`. `/reload` runs this flow (`SDK/docs/extensions.md`, lifecycle
diagram near line 383). Docs say to run `/reload` after editing settings or
resources (`SDK/docs/configuration.md:5`). Extension factories passed at
creation (built-ins, PiChamber plugins) are fixed per runtime; whether
`reload()` re-reads `-builtin:<name>` is implied by `resourceLoader.reload()`
but not verified by a test here.

## B. What PiChamber has today

### B1. Daemon commands and routes

- `resources.list` (`daemon.js:4890`) returns `publicResources(resourceCatalog(dir))`:
  `skills`, `prompts`, `agents`, each `{ id, kind, name, description?, location, editable, content? }`
  with `filePath` stripped (`daemon.js:3088-3136`). `location` is `project`,
  `package`, `global`, or `path` (`resourceLocation`, :3073-3078). IDs are
  `<kind>:<sha256(path) base64url>` (:3066).
- `extensions.list` (`daemon.js:4960-4996`) returns the live runtime's
  extension paths as `{ id: sha256(path)[0:16], name }` plus registered
  commands. The composer-controls listener is filtered out. No scope, no
  enabled flag, no package, nothing that is not loaded.
- Routes: `GET /api/pi/resources` (`packages/web/server/lib/pi/routes.js:1669`),
  `GET /api/pi/commands` (:1683, merges both), `GET /api/pi/extensions`
  (:2237), plus resource writes at :1869-1939.
- Rule: resource lists use opaque IDs and never disclose server paths
  (`DAEMON-DOC:62`; `extension-name.js` per `DAEMON-DOC:14`).
- Nothing lists packages, themes, disabled resources, or built-ins.

### B2. Skills, Prompt templates, and Plugins pages

- Skills (`packages/ui/src/components/sections/skills/SkillsPage.tsx`) is
  browse-only, with an All / Project / Global filter (:25, :366-390). Skills
  are not editable (`DAEMON-DOC:62`).
- Prompt templates write through `resources.prompts.*`. Project writes need
  an explicit directory and trust (`PROJECT_UNTRUSTED`, `daemon.js:3249-3254`),
  run in one queue (`transactResourceMutation`, :3176), under a cross-process
  lock at `<agentDir>/.pichamber/locks/pi-config.lock` (:3185-3188), and reach
  live sessions with `session.reload()` at the next safe edge (`DAEMON-DOC:62`).
  This is the closest precedent for scoped writes.
- Plugins: `GET /api/pi/plugins`, `PUT /api/pi/plugins/:id`, state routes
  (`packages/web/server/lib/plugins/routes.js:31-77`;
  `packages/web/server/lib/plugins/DOCUMENTATION.md`, "HTTP contract"). The
  enabled set lives in PiChamber's own `<dataDir>/pi/plugins.json`, not in Pi
  settings (same doc, `store.js`). The daemon gets it through
  `plugins.configure`; an enabled change recreates runtimes
  (`daemon.js:4881-4888`). UI: `packages/ui/src/components/sections/plugins/PluginsPage.tsx`
  with `usePluginsStore` and `useEffectiveDirectory` (:16-25).
- Settings metadata: slug `plugins`, title "Plugins", group `agent`
  (`packages/ui/src/lib/settings/metadata.ts:123-129`), icon `plug` (:272).
  Search entries `plugins.visuals`, `plugins.subagents`
  (`packages/ui/src/lib/settings/search.ts:596-604`). Rendered at
  `SettingsPageContent.tsx:75-76`. Screenshot pages `settings-plugins` and
  `settings-plugin-detail` use `/?settings=plugins` (`scripts/screenshots.mjs:701-711`).

### B3. How the daemon loads extensions

- Every runtime is built by `createAgentSessionServices` with
  `resourceLoaderOptions.extensionFactories` = built-ins, then plugin
  factories, then internal factories (`daemon.js:154-170`).
- Built-ins: `codemode`, `tool-search`, `mcp` load; `llama.cpp` is skipped on
  purpose (`builtin-extensions.js`, `LOADED_BUILTIN_EXTENSIONS`,
  `SKIPPED_BUILTIN_EXTENSIONS`). Each is `{ name, factory, replaceable: true, builtin: true }`.
- Plugins: `plugin-host.js` makes factories named `pichamber:<id>`
  (`plugin-host.js:185`) carrying the manifest's `replaceable`. Sub-agents is
  `replaceable: true` (`packages/web/plugins/subagents/package.json:19`) and
  registers one tool (`packages/web/plugins/subagents/extension.js:485`).
- Agent dir: `getAgentDir()` by default (`daemon.js:203`); `daemon-process.js`
  sets `PI_CODING_AGENT_DIR` from `--agent-dir` (`DAEMON-DOC:12`).
- Settings change paths: `scheduleRuntimeRecreation` (`daemon.js:1255-1276`)
  recreates runtimes now or defers until idle and returns `deferred`.
  `reloadRuntimeResources` (:1278-1292) does an identity-preserving
  `reloadSession` for prompt edits. Used by provider saves, trust changes,
  generic resource writes, and plugin toggles (`DAEMON-DOC:62`).

### B4. Project trust in PiChamber

- Known projects are auto-trusted when added or selected and they have
  trust-requiring resources (`daemon.js:558-563`, also `readPiSettings` :2972-2981).
- `settings.set` can set or clear trust; it writes `trust.json` under the
  shared lock and recreates runtimes (:2993-3061).
- Runtimes resolve trust through Pi; a saved "do not trust" wins
  (`DAEMON-DOC:99`).

## C. Proposed design

### C1. Server and daemon

New module: `packages/web/server/lib/pi/session-daemon/extension-config.js`.
It owns listing, the filter-entry writes, and removal. `daemon.js` only routes
commands to it. Routes go in `packages/web/server/lib/pi/routes.js` next to
`/api/pi/extensions`.

Daemon commands (private IPC):

1. `extensions.config.list { directory? }`
   - Builds two `DefaultPackageManager`s like `handleConfigCommand` does: one
     with `projectTrusted: false` for the global view, one with the saved
     trust for the project view, each with `builtinExtensions` = the names in
     `LOADED_BUILTIN_EXTENSIONS`. Calls `resolve(() => "skip")`.
   - Adds `listConfiguredPackages()`.
   - Adds the live runtime's loaded extension set and the Pi replacement
     warnings (C3) so the UI can show "not loaded because ...".
   - Response:
     ```
     {
       directory, trust: { trusted, denied?, requiresTrust? },
       packages: [{ id, source, scope: "user"|"project", kind: "npm"|"git"|"local",
                    installed: boolean, filtered: boolean, removable: boolean }],
       resources: [{ id, type: "extension"|"skill"|"prompt"|"theme",
                     name, group: "package"|"auto"|"settings"|"builtin",
                     packageId?, scope: "user"|"project",
                     enabled: { global: boolean, project?: "inherit"|"load"|"unload", effective: boolean },
                     loaded?: boolean, replacedBy?: string }],
       installFailures: [{ source, message }]
     }
     ```
   - `source` for npm and git packages is shown as written in settings (for
     example `npm:pi-btw@0.8.1`), which carries no server path. For local
     packages and all resources, send display names only (`extension-name.js`
     rules, package-relative paths, `~/` shortened home paths are still paths:
     do not send them). Recommendation: local package `source` is replaced by
     its folder name.
   - IDs: `sha256(scope + "\0" + type + "\0" + absolutePathOrBuiltinName)`,
     base64url, like `resourceId` (`daemon.js:3066`). The daemon re-resolves
     on every write and rejects unknown IDs (`RESOURCE_NOT_FOUND`), like
     `updateResource` (:3164-3166).
2. `extensions.config.set { directory?, id, scope: "global"|"project", state }`
   - `state` is `true|false` for global, `"inherit"|"load"|"unload"` for project.
   - Reimplements Pi's write (A3) in `extension-config.js`, using
     `SettingsManager` setters, then `flush()` and `drainErrors()`
     (`PI_SETTINGS_INVALID` on error, as `setPiSettings` does, :3048).
   - Runs inside `transactResourceMutation` and `withSharedPiConfigLock`.
   - Project scope requires `directory` and trust (`PROJECT_UNTRUSTED`).
   - Then `scheduleRuntimeRecreation()` (global: all runtimes; project: that
     directory) and returns the fresh list plus `deferred`.
3. `extensions.packages.remove { directory?, id }`
   - Looks up the package by ID, calls `removeAndPersist(source, { local })`.
   - Errors: `RESOURCE_NOT_FOUND`, `PROJECT_UNTRUSTED`,
     `PACKAGE_REMOVE_FAILED` (npm/git failure, message capped and path-free),
     `PACKAGE_NOT_CONFIGURED` when settings had no match.
   - Partial failure: files gone but settings write failed. Return an error
     that says so; the next list shows it with `installed: false`. Because
     listing uses `onMissing: "skip"`, it will not be silently reinstalled
     by Settings, but a session start would reinstall it (`resolve()` default).
     State this in the UI error text.
   - Then runtime recreation, as above.

Routes:

- `GET /api/pi/extensions/config?directory=`
- `PUT /api/pi/extensions/config/:id` body `{ scope, state, directory? }`
- `DELETE /api/pi/extensions/packages/:id?directory=&scope=`

Each projects the daemon result through a whitelist, as existing routes do.
The global `/api` auth gate applies.

PiChamber plugins stay in `plugins.json` and their existing routes. The page
merges both lists; the server does not.

### C2. UI

- Rename the page title to "Extensions & Plugins". Keep the slug `plugins`
  so `/?settings=plugins`, screenshots, and deep links keep working; add
  `extensions` to keywords (`metadata.ts:123-129`). If the owner wants a new
  slug, add it to the legacy map (`metadata.ts:193-222`).
- Page sections, top to bottom, using `SettingsPageLayout`,
  `SettingsSection`, `SettingsCheckboxRow`/`Switch`, `SettingsChipGroup`
  (`.agents/skills/settings-ui-patterns/SKILL.md`, "Quick Primitive Selection"):
  1. Scope chips: Global / This project (project disabled with a reason when
     there is no directory or no trust).
  2. PiChamber plugins: the current list, unchanged.
  3. Pi packages: one row per package, its resources nested below as plain
     rows (no card in card), a Remove action in a row menu with a confirm
     dialog naming the package and scope.
  4. Extensions (loose): auto-discovered and settings-listed.
  5. Built-in: `codemode`, `tool-search`, `mcp`.
  6. Skills, prompt templates, and themes from the same list, collapsed by
     default, or linked from the Skills page. Recommendation: show only
     extensions on this page and add per-skill toggles on the Skills page in
     a later ticket.
- Project scope rows show a three-state control (Inherit / On / Off) with the
  inherited value muted, matching `pi config`.
- Data access in `piClient` (`packages/ui/src/lib/pi/client.ts`), a small store
  next to `usePluginsStore`, keyed by runtime and directory, invalidated on
  endpoint switch (`runtimeEndpointReset.ts`) and after `extensions.config.set`.
- Rename touches: `metadata.ts`, `search.ts` (new entries per section),
  `SettingsPageContent.tsx` (only if the component name changes),
  `packages/docs/content/docs/extensions.mdx`, `scripts/screenshots.mjs`
  (`settings-plugins` captions plus a new `settings-extensions` page with a
  seeded user extension and package), and the screenshot list in `CLAUDE.md`.
- Runtimes: all four use the same HTTP routes; the server is the authority.
  Web, desktop, hosted mobile: same page. Capacitor mobile: same page against
  its connected server. Removal and toggles change the server host's Pi
  setup, not the device; the page should say "on this server" when the
  server is remote (an existing remote label exists, `useActiveRemoteLabel.ts`).

### C3. A user extension that registers the same tool as a plugin

Pi drops a `replaceable` extension when a non-replaceable one registers the
same tool, command, or flag (`omitReplacedExtensions`,
`SDK/dist/core/resource-loader.js:85-112`). It only writes a warning for
`builtin:` paths (:102-109); a replaced `pichamber:subagents` is dropped
silently.

So if the user has their own `subagent` extension, the bundled Sub-agents
plugin can show as on but not be loaded. Design:

- The daemon compares the plugin's registered names (it already measures
  them in `impact.js`) with the loaded extensions and returns
  `replacedBy: "<extension display name>"` for that plugin and for any
  replaced built-in.
- The plugin row says "Not loaded: <name> registers `subagent`" with a
  button that turns the other extension off in global scope (one
  `extensions.config.set`). The other extension's row says it overrides the
  plugin.
- No new mechanism: both switches already exist; this only makes the
  winner visible.

### C4. Security

- Toggles and removal change what code runs; keep them behind the existing
  `/api` auth gate and private daemon IPC. No new unauthenticated path.
- Never trust browser IDs or sources: the daemon re-resolves every ID against
  a fresh resolve for that directory and scope.
- Project scope writes need saved trust (`PROJECT_UNTRUSTED`), as Pi does.
- Remove calls only `removeAndPersist`; PiChamber never `rm`s paths itself.
  Local packages are never deleted (Pi does the same).
- Listing must not install (`onMissing: () => "skip"`).
- No server path, npm prefix, or git URL with credentials crosses the API.
  Strip userinfo from git sources before sending.
- Bundled plugin packages are not Pi packages in settings and cannot be
  removed from this page.

### C5. Tests and validation

Per `CLAUDE.md` "Validation": focused unit tests, `bun run test`, package
type-check and lint, `bun run dead-code` when exports change.

- `extension-config.test.js`: the write function against fixtures for every
  case in A3 (top-level global, package global, project inherit/load/unload,
  built-ins, string to object and back, `autoload: false` cleanup), compared
  to the documented rules.
- Daemon test: list does not install (spy on `installParsedSource` or offline
  mode), IDs are path-free, untrusted project write fails, remove calls
  `removeAndPersist`, runtimes are recreated.
- Route tests in `routes.test.js` for whitelisting.
- UI: store test and a page test; screenshots at desktop and mobile.
- An e2e in the style of `session-daemon-plugins.e2e.test.js` with a temp
  agent dir: toggle a seeded extension off and see it leave `extensions.list`.

### C6. Tickets in build order

1. **Pi filter-write module.** `extension-config.js` with pure functions:
   `setResourceEnabled(settingsManager, item, scope, state)`. Accept: unit
   tests cover every case in A3; no daemon wiring.
2. **Daemon list command.** `extensions.config.list` with path-free IDs,
   both scopes, built-ins, packages, install failures, no installs. Accept:
   daemon test, `DAEMON-DOC` updated.
3. **Daemon set command.** `extensions.config.set` with trust, lock, queue,
   recreation, `deferred`. Accept: tests for each error and a live runtime
   dropping the extension.
4. **Daemon remove command.** `extensions.packages.remove`. Accept: tests with
   a stub package manager for npm, git, local, not-found, partial failure.
5. **Routes and `piClient`.** Three routes and client methods with
   whitelisting. Accept: route tests, `bun run dead-code` clean.
6. **Replacement detection (C3).** `replacedBy` on plugins and built-ins.
   Accept: test with a user extension registering `subagent`.
7. **UI page.** Rename, scope chips, packages, extensions, built-ins, remove
   dialog, replacement notice. Accept: screenshots desktop and mobile, search
   entries, locale rules followed.
8. **Docs and screenshots.** `extensions.mdx`, screenshot seed with a demo
   package and extension, `CLAUDE.md` page list. Accept: captures exist.
9. **(Optional) skills, prompts, themes toggles** on their own pages, using
   the same commands.

### C7. Owner decisions

1. Keep slug `plugins` or move to `extensions`? Recommend keep.
2. Show skills, prompts, themes on this page or only extensions?
   Recommend extensions only; toggles for the others on their own pages.
3. Offer `llama.cpp` in the Built-in list though PiChamber never loads it?
   Recommend leave it out and say so in an info hint.
4. Local package `source`: send folder name only? Recommend yes.
5. Project-scope three-state control or a simple switch? Recommend three
   state, to match `pi config` and avoid surprising writes.
6. Should removal also be allowed for project packages from a phone?
   Recommend yes, with the same confirm.
7. Ask upstream to export a headless toggle helper? Recommend yes, but build
   ticket 1 now.

Decided 2026-11-17: the owner took the recommendation on all seven. The slug
stays `plugins`, the page lists extensions only, `llama.cpp` is left out with
a note, local packages send the folder name, project scope is three state,
removal works from a phone with the same confirm, and our own toggle code is
built now with an upstream request to follow.

### C8. Risks and unknowns

- Not verified: that `session.reload()` alone (without recreation) applies
  `-builtin:<name>` changes; the design uses recreation to avoid relying on it.
- Not verified: behaviour when the global `npmCommand` setting points to a
  missing binary during remove (npm failure path is only read, not run).
- Our reimplemented write can drift from Pi's. Pin it with tests and recheck
  on each SDK upgrade (`sdk-upgrade.test.js` already guards built-ins).
- Concurrent edits by the Pi CLI: the shared lock covers PiChamber daemons
  only; Pi's own `SettingsManager` write is not verified to take the same lock.

## Later: marketplace

It would add search (npm keyword or a curated index), `installAndPersist`,
and `update(source)` (`package-manager.js:833`, :859), with progress events
from `setProgressCallback` (`package-manager-cli.js:888-895`) streamed to the
UI. It reuses: the list command and IDs, the scope and trust checks, the lock
and mutation queue, runtime recreation, and the remove dialog pattern. To keep
it unblocked, the list response should already carry `kind` and `installed`,
and the remove command should be shaped so install and update can sit beside
it as `extensions.packages.install` and `extensions.packages.update`.
