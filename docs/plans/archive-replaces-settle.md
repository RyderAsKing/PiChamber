# Plan: Archive replaces Settle

Status: accepted
Scope: web, desktop, hosted mobile, Capacitor mobile

## 1. Goal

PiChamber has two ways to put a session away. **Settle** files it on a
sidebar shelf in Threads and By folder, and sessions settle on their own
after 3 idle days. **Archive** marks the session itself: it leaves the
sidebar and lives in the Archive dialog. Users have to learn both, and the
two drift apart in every view.

This plan removes Settle. Archive takes over its actions, its undo, and its
"send a message to bring it back" rule, plus an automatic rule that is on for
new installs. Settle has only shipped in the release candidate, so few users
have settled sessions.

## 2. Decisions

1. **One state: archived.** The settled flag goes away. Snooze and Pin stay.
2. **Every Settle action archives instead.** That covers the row's Settle
   button, the Settle menu item, and the toast's Undo. Archiving no longer
   asks for confirmation: it happens straight away, and a toast names the
   session with Undo. Delete keeps its confirmation.
3. **Archiving unpins**, as settling does today. Undo restores the pin.
4. **Sending a message unarchives.** The server clears the archive mark when
   it accepts a prompt or a `!` command for the session, the same way it
   clears a snooze today.
5. **Workspace, By folder, and Threads hide archived sessions.** None of them
   gets an Archived shelf; the Settled shelf is removed.
6. **Search finds archived sessions in every view.** Matches show in place
   with a muted title, and their menu offers Unarchive instead of Archive.
7. **Timeline shows every session, archived included,** with archived rows
   muted. Timeline moves under a Legacy group in the sidebar view setting.
8. **Auto-archive** archives sessions idle for N days. It is on at 7 days for
   new installs. Existing installs keep what they had (section 6), and
   Settings suggests turning it on while it is off.
9. **Auto-archive skips** pinned sessions, running sessions, sessions waiting
   on the user, snoozed sessions until they wake, and the open session.
   Archiving one of these by hand still works.
10. **Auto-delete** deletes archived sessions N days after they were archived.
    It is off by default and never touches a session that isn't archived.
11. **Migration:** sessions settled by hand become archived once. Sessions
    that only auto-settled follow the auto-archive setting.

## 3. Behavior by view

| View | Not archived | Archived | Archived during a search |
|---|---|---|---|
| Workspace | Listed | Hidden | Listed in place, muted |
| By folder | Listed in its folder | Hidden | Listed in its folder, muted |
| Threads | Pinned, Working, Recent, Snoozed | Hidden | Listed in place, muted |
| Timeline (legacy) | Listed by recency | Listed by recency, muted | Listed, muted |
| Archive dialog | Not listed | Listed | Its own search, unchanged |

Threads keeps dragging between Pinned and Recent. Dropping on Settled goes
away with the shelf.

An archived session still opens from search, Timeline, or the Archive dialog.
It reads normally, and sending to it unarchives it (decision 4).

## 4. Server

### 4.1 Unarchive on send

`routes.js` calls `clearShelfForActivity` after the daemon accepts a
`prompt`, `steer`, or `follow-up` send, or a `bash` command. Extend that step to also
call `archiveStore.set(sessionId, false)` when the session is archived. As
with the shelf, the send has already succeeded, so a failed archive write
logs and does not fail the request.

Every client must see the session come back without a reload. The sending
client clears `archived` optimistically. Before building, check how other
clients learn about archive changes today: the archive route answers `204`
and broadcasts nothing. If no catalog refresh follows a send, add one
(a catalog event, or the same reload the shelf store does when the working
set changes) instead of relying on a later list.

### 4.2 Shelf store

`session-shelf-store.js` keeps `snoozedUntil` / `snoozedAt` and drops
`settled` / `settledAt`:

- **Migration on first read:** for each entry with `settled: 'settled'`,
  archive the session (keeping `settledAt` as the archive time) and remove
  the settled fields. Entries with `settled: 'active'` lose the field. This
  runs once under the existing cross-process lock and writes both files
  atomically: the archive file first, then the shelf file. If the archive
  write fails, the shelf file stays unchanged and the migration retries on
  the next read.
- **Older clients:** a release-candidate desktop app may still send
  `settled: 'settled'` to a new server. The route maps that to an archive.
  `settled: 'active'` and `settled: null` are accepted and do nothing. Remove
  this mapping one release later.

### 4.3 Settings

New portable UI settings in `ui-settings-store.js`, replacing the retention
fields:

| Field | Values | Meaning |
|---|---|---|
| `sessionAutoArchiveAfterDays` | 0 (off), 1–365 | Archive sessions idle this many days |
| `sessionAutoDeleteAfterDays` | 0 (off), 1–365 | Delete archived sessions this many days after archiving |

Off is `0`, not `null`, so the value survives stores that drop nulls (the
same reason `sidebarAutoSettleAfterDays` uses 0).

The server decides the starting values once, on the first settings read
after the update, and writes them so every client agrees:

- **New install** (no saved `settings.json`, or one with no saved fields):
  auto-archive 7, auto-delete 0.
- **Existing install:** mapped from the old retention fields.

| Old `autoDeleteEnabled` / `sessionRetentionAction` / `autoDeleteAfterDays` | Auto-archive | Auto-delete |
|---|---|---|
| Off, or missing | 0 | 0 |
| On, `archive`, N | N | 0 |
| On, `delete`, N | N | 30 |

The last row is the only one where behavior changes: the old setting deleted
sessions straight from the list after N days. Now they are archived after N
and deleted 30 days later, so nothing is deleted sooner than before.

`sidebarAutoSettleAfterDays` and the old retention fields are read for this
migration only and are no longer written. Remove them from the sanitizers one
release later.

## 5. Client

### 5.1 Shelf rules (`lib/sessionShelf.ts`)

- Sections become `pinned | active | working | snoozed`. Remove
  `settled`, `isSettled`, `settledAtFor`, and the auto-settle constants and
  helpers.
- `applyShelfPatch` and `PiSessionShelfInput` drop `settled`.
- `useSessionShelfStore` keeps snooze only.

### 5.2 Sidebar

- `SidebarThreadsList`: remove the Settled shelf, its paging, and the
  Settled drop target. `THREADS_SHELVES` and the folder tree's
  `FOLDER_SHELVES` become `['snoozed']`. Old `settled` values in
  `oc.sidebar.shelves.expanded` are ignored.
- `SessionNodeItem` / `SessionNodeContextMenu`: the Settle and Un-settle
  actions become Archive and Unarchive. Rows have only one put-away action,
  so the separate quick archive and settle buttons collapse into one Archive
  button.
- `settleSession` in `useSessionShelves.ts` becomes `archiveSessionWithUndo`:
  unpin, archive optimistically, show "Archived “title”" with Undo, and roll
  back with an error toast on failure. Archiving a session archives its
  forks with it (as the confirmation dialog does today), and Undo restores
  the same set.
- Search: `useSessionSidebarSections` and the Threads and Timeline item
  builders include archived nodes while a query is active. Muted titles
  already exist for put-away rows; archived rows use the same style.
- Timeline: always includes archived sessions (in `allFolderSessions` for
  Timeline only), muted.
- Bulk Archive in the selection bar: no confirmation, one toast with a count
  and Undo.

### 5.3 Auto-archive and auto-delete

Extend `hooks/useSessionAutoCleanup.ts`, which already holds the
authoritative-catalog checks (ready directories only, fresh recheck before
each write, explicit partial and stale results). Split it into two passes:

1. **Archive pass:** candidates are sessions that aren't archived, idle
   longer than `sessionAutoArchiveAfterDays`, and not exempt (decision 9).
   Idle time uses `sessionActivityAt`, so a session that woke from a snooze
   counts from its wake time. Drop the "keep the 5 newest" rule here: the
   exemptions cover the open and active sessions, and archiving is undoable.
2. **Delete pass:** candidates are archived sessions whose archive time is
   older than `sessionAutoDeleteAfterDays`.

Runs happen on load and then hourly while a client is open; they no longer
wait 24 hours, so a session archives within an hour of crossing the line.
Several clients may run at once: archiving is idempotent, and the fresh
recheck before each write skips a session that a send just revived.

Automatic runs show no toast.

### 5.4 Settings UI

- **Appearance → Navigation → Sidebar view:** offers Workspace, By folder,
  and Threads. Timeline sits under a collapsed "Legacy views" disclosure
  below them, which starts open when Timeline is the current view, so no
  one on Timeline loses sight of it. Remove the "Settle idle sessions" row.
- **Sessions → Session retention** becomes **Archive and delete**:
  - "Archive idle sessions after [7] days". Empty means Off. While it is
    off, a line under it reads "Archiving sessions idle for 7 days keeps the
    sidebar to what you're working on.", with a Turn on button that sets 7.
  - "Delete archived sessions [ ] days after archiving". Empty means Off.
    Its info text says deletion is permanent, applies only to archived
    sessions, and counts from the day a session was archived, so with
    auto-archive at 7 and delete at 30 a session goes 37 days after it was
    last used.
  - Manual cleanup runs both passes now, as the current button does.
- `lib/settings/search.ts` and `lib/settings/metadata.ts`: replace the
  `appearance.auto-settle` and retention entries with the two new ones,
  keeping "settle", "retention", and "cleanup" as search keywords.

## 6. Upgrade paths

| Who | What they see after updating |
|---|---|
| New install | Auto-archive on at 7 days; Timeline under Legacy views |
| Stable user, retention off | Nothing archives by itself; the sidebar is unchanged apart from the Settings suggestion |
| Stable user, retention on | Same rule as before, now as auto-archive (and auto-delete for the delete action) |
| Release candidate user | Hand-settled sessions are archived. Auto-settled sessions return to the list until auto-archive (if on) archives them |
| Anyone on Timeline | Timeline stays selected and now also lists archived sessions |

## 7. Out of scope

- An Archived shelf in any view.
- Renaming the OpenChamber "subtask" names (`UserSubtaskPart`,
  `subtaskCount`). The archive confirmation copy that says "sub-task" goes
  away with the dialog. Fork naming elsewhere is a separate cleanup.
- Server-side auto-archive with no client open.

## 8. Documentation and screenshots

Update these docs:
- `packages/ui/src/components/session/sidebar/DOCUMENTATION.md`: Threads,
  By folder, search, and Timeline behavior.
- `packages/ui/src/stores/DOCUMENTATION.md`: the shelf store holds snooze only.
- `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`: shelf
  store, unarchive on send, the settings migration.
- `CHANGELOG.md`.

Update these screenshot pages:
- `sidebar-threads`, `sidebar-threads-hover`, `sidebar-threads-settle`: the
  seed's settled sessions become archived sessions. Rename
  `sidebar-threads-settle` to `sidebar-threads-archive`.
- Add a search page that shows an archived match.

## 9. Tests

- Shelf store: migration (settled to archive, active dropped, failed
  archive write leaves the shelf untouched), older-client `settled` mapping.
- Routes: prompt, steer, follow-up, and bash sends unarchive; a failed archive write
  still answers 202.
- Settings: new install gets 7/0; each old retention combination maps as in
  section 4.3; the decision runs once.
- `lib/sessionShelf.ts`: no settled section; pinned, working, waiting, and
  snoozed sessions never become auto-archive candidates.
- Cleanup: the archive pass skips exempt and open sessions and rechecks
  before each write; the delete pass counts from archive time and ignores
  sessions that aren't archived; one failed directory doesn't block others.
- Sidebar views (`SidebarViewModes.test.tsx`): archived sessions hidden in
  Workspace, By folder, and Threads; shown muted during a search; always
  shown in Timeline.
- Archive with Undo: unpin and restore, forks archived and restored together,
  rollback on failure.

## 10. Build order

1. Server: unarchive on send, shelf migration and older-client mapping,
   settings fields and migration.
2. Client rules and views: shelf sections, Threads and By folder without
   Settled, search and Timeline with archived rows.
3. Archive actions: one Archive button, Undo toast, unpin, bulk toast.
4. Auto-archive and auto-delete passes, then the Settings page.
5. Docs, settings search, screenshots, changelog.

## 11. Resolved questions

1. Deleting always comes later than archiving: auto-delete counts from the
   archive time, so a session is deleted M days after it was archived, and
   N + M days after it was last used. For "retention on, delete after N
   days", that gives auto-archive at N and auto-delete 30 days later
   (section 4.3).
2. Timeline sits under a collapsed "Legacy views" disclosure (section 5.4).
3. Both settings take 1–365 days, or Off.
