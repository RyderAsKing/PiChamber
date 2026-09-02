# Mobile App Surfaces — Gesture and Layout Contracts

## Gesture Ownership

- **Phone drawers** (`MobileSessionsSheet`, `MobileWorkspaceDrawer` with `variant=\"drawer\"`) own their drag surfaces via `useDrawerSwipe`. The drawer element itself is the touch surface (portaled to `document.body`), outside the chat. `useEdgeSwipe` owns the **chat** surface (`chatMainRef`) for opening drawers from content. Tablet sidebars own a separate two-layer panel surface.

- **Event surfaces are distinct** because phone drawers are portaled outside the chat element. Sharing geometry (`gestureMath`) is intentional, but hooks remain separate: `useDrawerSwipe` attaches to the drawer/scrim, `useEdgeSwipe` attaches to the chat. Do not merge the hooks; keep the event targets separate.

- **Direction is decided once** after `DRAG_THRESHOLD` and `MAX_OFF_AXIS`. Vertical or wrong-direction gestures reset tracking without side-effects. Both left and right panels follow the same `gestureMath` thresholds (`VELOCITY_THRESHOLD`, `SETTLE_PROGRESS`).

## Abort and Cleanup Invariants

- **Single cancellation path**: `cancelGesture` in `useDrawerSwipe` and `cancelGesture`/`abortDraggingWithSnap` in `useEdgeSwipe` always:
  - Restores drawer to known starting state (`transform: none` when open, scrim `opacity: 1`, `pointerEvents: auto`).
  - Restores `transition` (phone: `MOBILE_DRAWER_DURATION_MS` easing; tablet inner: `200ms cubic-bezier(0.22,1,0.36,1)`).
  - Clears transient flags (`tracking`, `isDragging`, `hasDecided`); progress is kept in refs rather than per-frame DOM datasets.
  - Never calls `onClose` for an aborted gesture.

- **Triggers**: multi-touch (`touches.length !== 1`), `touchcancel`, and hook cleanup/unmount all go through the same path. A second drag starting before the previous settle finishes interrupts the running transition (`transition: none` on the new `touchstart`) and recomputes from the current finger.

- **Settle only fires `onClose` for a committed close** (progress < `SETTLE_PROGRESS` or closing fling). Aborted gestures snap back to `wasOpen` with an explicit `onLeftProgress( wasOpen ? 1 : 0 )` + `onDragEnd(wasOpen)`.

- **Stale timeouts are cleared** via `dragTimeoutsRef` in `MobileShell` before any new drag or open/close state change.

## Ref-Based Surface Control (No Per-Frame Queries)

- `MobileShell` owns `phoneLeftDrawerRef` / `phoneLeftScrimRef` / `phoneLeftRootRef` (and right equivalents) and passes them into `MobileSessionsSheet` / `MobileWorkspaceDrawer` via `drawerRefExternal` etc. The drawer components merge external and internal refs with callback refs.

- `useEdgeSwipe`'s `onLeftProgress`/`onRightProgress` mutate **only via refs** (`applyPhoneDrawerProgress`, `applyTabletPanelProgress`). No `document.querySelector` or `getBoundingClientRect` per `touchmove`. Width helpers use `ref.current?.offsetWidth` (fallback `window.innerWidth`), not queries.

- **Drawer-surface adapter** (`drawerSurface.ts`) owns all imperative style writes. `MobileShell` is responsible only for open state (`setSidebarOpen`, `setSessionsSheetOpenSafely`, `setWorkspaceOpenSafely`) and for committing `didSettleOpen` after `finish`. No React `setState` occurs inside `onLeftProgress`/`onRightProgress`.

- **Verification**: `bun test -t \"mobile drawer lifecycle\"` asserts no `querySelector` in the hot path, that closed tablet shells use `inert`, and that `MobileShell` no longer contains `style.transition = ''` for React-owned closed styles. The chat tree and panel modules are memoized so sidebar state changes do not rerender unrelated heavy surfaces.

## Tablet Layout Without Reflow

- **Two layers**:
  - Outer *layout shell* (`aside` with `asideRef`) owns `width`/`minWidth`/`maxWidth` (0 when closed, `leftResize.width` / `rightResize.width` when open) and commits layout width without a CSS width transition.
  - Inner *surface* (`leftPanelInnerRef` / `rightPanelInnerRef`) owns a fixed `width: var(--oc-ipad-sidebar-width)` and `transform`.

- **During an opening drag** (closed → preview), shell stays `width: 0` and `overflow: visible`; inner translates from `translateX(-w)` (left) or `translateX(w)` (right) toward `0`. Chat does not reflow per-move. Closed tablet shells use `inert`, and the session sidebar receives `isVisible={false}`, so hidden sidebar work is gated.

- **During a closing drag** (open → preview), shell stays `width: w` and inner translates outward. Only `inner.transform` is mutated per-move.

- **On settle or cancellation**, inner animates to its final `translateX` with `200ms` easing, and temporary shell overflow is cleared after `220ms`. The shell's `width` is committed via React state (`sidebarOpen`/`workspaceOpen`) once; it is not CSS-transitioned, so chat reflows once instead of on every animation frame.

- Both sides and both directions are covered; `usePanelSlide` still drives the non-drag open/close `transform` for the left sidebar's inner surface.

- **Toggle-only titlebar controls** have a fixed `2.5rem` header reservation. Do not measure and publish their width through root CSS variables on each sidebar toggle: those geometry reads synchronously resolve the invalidated layout tree. Electron frameless controls remain measured because their native-control footprint is variable.

## Horizontal-Scroll Exclusions

- **Shared predicate**: `isSwipeExcludedTarget` in `gestureMath` (selector `button, a, input, textarea, select, [contenteditable], [data-no-drawer-swipe]` + `scrollWidth > clientWidth && overflowX auto|scroll`). Single source for both hooks. `useEdgeSwipe` (content surface) always excludes interactive controls; `useDrawerSwipe` (drawer-local close) passes `{ excludeInteractive: false }` so a swipe anywhere on the drawer can close it — only the explicit `[data-no-drawer-swipe]` marker and horizontal scrollers remain excluded.

- **Applied for both open and closed states on the content surface**: `useEdgeSwipe` checks `isSwipeExcludedTarget` before tracking even when a drawer is already open. Previously it only checked when closed, causing horizontal scroll inside code blocks / terminal / composer / tab lists to be hijacked as a close gesture.

- **Explicit markers** (`data-no-drawer-swipe="true"`) on:
  - `MobileWorkspaceDrawer` tab strip
  - `ComposerFooter` mobile actions
  - `TerminalView` quick-keys bar
  - `MessageBody` code `pre` / font-mono blocks
  - `FileAttachment` scroll container
  - `SidebarHeader` mobile tabs
  - `Header` main tab strip
  - `FilesView` editor tabs, `PierreDiffViewer`

- **Touch-action**: chat containers (`chatMainRef`, `mainInteractiveRef`, drawer drawers) use `pan-x pan-y` (previously `pan-y`) so horizontal descendants can scroll natively; `preventDefault` is only called after horizontal intent is locked.

## Shared Mobile Files and Changes Ownership

- Dedicated mobile no longer owns parallel Files or Changes controllers. `MobileWorkspaceDrawer` lazy-loads the shared `FilesView` and `GitView` entrypoints instead.
- Files uses `FilesView chrome="mobile" mode="editor-only"`. `components/views/files/MobileFilesChrome.tsx` owns the mobile list/header presentation. Shared directory loading and polling live in `useFilesTree`; search request policy for both `FilesView` and `SidebarFilesTree` lives in `useFilesViewSearch`; file mutations for both surfaces live in `useFileOperations`. `loadFileDocument` owns file-kind classification plus text normalization. `useFileEditorSave` owns guarded writes, line-ending serialization, manual-save status, and autosave timing. `useDirtyFileNavigation` owns the single pending selection, close, or main-tab intent while the unsaved-changes modal is active. `useFileViewerModes` owns per-file preview choices, preference propagation, and the Draw.io preview/save lifecycle. `useFileEditorNavigation` coordinates deferred file selection, editor mounting, focus requests, and line jumps. `useFileStatReconciliation` polls authoritative metadata without overwriting dirty drafts or treating stat failures as missing files. `FilesView` composes those modules with selection, stale-load rejection, tabs, and editor presentation. Mobile path helpers live beside that chrome in `components/views/files/mobileFilesPaths.ts`.
- Changes uses `GitView chrome="mobile"`. `components/views/git/MobileGitChrome.tsx` owns the mobile list/detail route and presentation; `GitView` owns authoritative status, remotes, index mutation queue/rollback, revert, commit, sync, and diff prefetch. The drawer passes `isActive={open && tab === 'changes'}` so hidden Changes work stays gated.
- Mobile commit/sync behavior stays visually scoped to the mobile surface: desktop commit-and-push fireworks are not triggered by `chrome="mobile"`.
- The Files consolidation is not a startup-performance claim. Opening the mobile Files tab currently loads the full `FilesView` module, including editor/preview dependencies. A later split should move editor-heavy implementation behind an on-demand boundary so browsing a directory does not pay that cost before a file is opened.

## Runtime Git Ownership

- UI feature code consumes the injected `RuntimeAPIs.git` contract directly. The old `lib/gitApi.ts` forwarding layer was removed because it duplicated the runtime-vs-HTTP decision for every method. React surfaces resolve Git through `useRuntimeAPIs()`; non-React callers that can run before a provider exists keep a narrow `gitApiHttp` fallback at the call site.
- `git/gitStatusPredicates.ts` and `git/gitChangeDescriptors.ts` define the shared staged, working, and new-file classification and change descriptors used across `GitView`, `ChangeRow`, and `DiffView`; untracked `?` entries remain working changes rather than staged changes.
- Optional runtime capabilities such as commit-file diff and credential discovery fall back only for that capability; they do not reintroduce a broad compatibility adapter. Types come from `lib/api/types.ts`.

## Git View Lazy Mount

- `MainLayout` does not mount `GitView` on initial mobile chat startup. It mounts the right-drawer view only when `(mobileRightSidebarOpen || mobileRightDrawerVisible)`; a route-addressable mobile `activeMainTab === 'git'` mounts the full view only when the drawer is closed, so `?tab=git` cannot produce a blank main area.

- Draft/identity state survives drawer unmount via `gitViewSnapshots` (per-directory LRU in `git/gitViewSnapshots.ts`). Gitmoji selection lives in `git/GitmojiPickerDialog.tsx` with commit prefix parsing in `git/gitmojiMatcher.ts`.

- Hidden `useGitStore` selectors and `isActive`-gated effects do not run while the drawer is closed because the component is not mounted. The `GitView` chunk is not requested during initial mobile startup (verified via Network panel: no `GitView` request before the first right-drawer open).

## Tablet-Layout Subscriptions

- `useTabletLayout` is now `useSyncExternalStore` with a single global `resize` listener and a single `matchMedia('(orientation: landscape)')` listener. Stable snapshots (`isSameTabletLayout`) avoid re-renders when values are equal.

- SSR snapshot is `{ enabled: false, roomyForPanels: false }`. Cleanup removes listeners and nulls the snapshot when the last consumer unsubscribes. Fold/orientation transitions are coalesced via `requestAnimationFrame`.

- `readTabletLayout` remains the pure geometry helper (phone vs tablet vs foldable vs `isIPadApp` override, `WORKSPACE_PANEL_MIN_WIDTH_PX` gate).

## Validation Checklist

- `bun test` — `gestureMath.test.ts` (velocity/progress, two-finger, touchcancel, second-drag, tablet open), `tabletLayout.test.ts`, `mobileDrawerLifecycle.test.ts`.
- `bun run type-check` — workspace-wide.
- `bun run lint` — workspace-wide (only pre-existing `ComposerEditor` warning).
- `bun run dead-code` — no new unused exports.
- `git diff --check` — no whitespace errors.
- Manual profiles on a WebView/Chrome: no `querySelector` in `touchmove` timeline, no Git chunk before drawer open, no React renders from drag moves, no stale transforms after `touchcancel`/multi-touch, horizontal scrolling in code/terminal/composer/tabs remains functional.

## Failure and Rollback

- A failed gesture leaves the drawer in its starting state (open or closed) with transitions cleared. No partial opacity/transform remains.
- A failed `readTabletLayout` (e.g., `window` undefined during SSR) returns the default layout without throwing.
- `GitView` mount failure does not affect chat; the drawer can be retried. No optimistic state is stranded.
