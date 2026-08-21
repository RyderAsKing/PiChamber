# Providers Settings Rework — Grid Cards Plan

> Goal: bring `Providers` visual & structural consistency to the flat-hierarchy pages (General / Appearance / Chat / Notifications) while introducing a scalable catalog browse: a searchable grid of provider cards, auth-first sorting, refresh, and drill-down to models.

**Status**: Plan only (no code change).  
**Owner**: `packages/ui/src/components/sections/providers/*`, `packages/ui/src/lib/settings/*`, `packages/ui/src/components/views/SettingsView.tsx`  
**Skills loaded**: `pichamber-change-discipline`, `settings-ui-patterns` (layout/controls/search), `theme-system`, `locale-ui-patterns` (implicit), `ui-api-decoupling`

---

## 1. Why now — current vs target

### Current

- `providers` metadata: `kind: 'split'` (`SETTINGS_PAGE_METADATA` in `packages/ui/src/lib/settings/metadata.ts`)
- `SettingsView` renders a persistent 280px `ProvidersSidebar` (left) + `ProvidersPage` detail (right).  
  `ProvidersSidebar.tsx` — vertical list, `ProviderLogo + label + model count + check`, header refresh.  
  `ProvidersPage.tsx` — `SettingsPageLayout` showing `Authentication` + `Available Models` for the `selectedProviderId` from `usePiProviderSelectionStore` (`__pi_custom_provider__` synthetic id for “Other / Custom”).
- Flat pages (General/Appearance/Chat/Notifications/Sessions) use single `SettingsPageLayout` + `SettingsSection` primitives, `@container` responsive, no split. The split makes Providers (and Projects) feel like a different product.
- No provider-level search on the sidebar; only model-filter inside detail when `>8` models. No grid affordance; no at-a-glance auth or model-count card.

### Target (requested)

> Each provider is a grid card showing: logo, provider name, count of models, auth status (green lock).  
> Top controls: search (filters cards) + refresh button.  
> Click card → show models inside that provider.  
> Sort: authenticated first, then unauthenticated alphabetical.  
> (Ambiguity resolved below: both groups alphabetically sorted; stable secondary sort.)

### Consistency decision — cards vs flat rule

`settings-ui-patterns` SKILL says: `Flat hierarchy through spacing and typography; no cards, boxed backgrounds, or row chrome.`  
**Exception justification**: Providers is an *entity catalog* (like Projects/Skills/Snippets), not a plain setting field row. The SKILL primitives stay for the *detail* view (Auth + Models) but the *browse* view is intentionally a card grid — analogous to a marketplace catalog. This is an intentional split from flat settings and must be documented as such. Cards use semantic tokens only (no palette hardcoding) and remain `@container` responsive.

---

## 2. UX Spec

### 2.1 Grid browse state (default)

```
SettingsPageLayout
  title: "Providers"   // L1 via SETTINGS_PAGE_TITLE_CLASS, isMobile? no title (header owns it)
  description: "Manage model providers and authentication."  // or keep existing copy
  headerEnd: [ Search Input | Refresh Button | (Add Custom) ]

  // optional status when failed
  // optional authenticated section header + grid

  Section divider={false}
    grid: @container-driven
      grid-cols-1 @xl:grid-cols-2 @3xl:grid-cols-3 gap-3

    Card (button, role=button, focus ring):
      ┌──────────────────────────────────────┐
      │ [Logo 32]  Provider Label     [lock] │  // lock if authenticated, green
      │          provider-id (mono,muted)    │
      │                                      │
      │  12 models          [● Connected]   │  // or model count + auth pill
      └──────────────────────────────────────┘

    Authenticated first → divider/label "Connected" then "Available" if both groups present
    OR just sorted without sections (simpler) — decision below.
```

**Card anatomy** (per request):

- `ProviderLogo` 32px (`size-8`) with fallback (no logo → initials / generic `cloud` Icon in muted circle)
- Label (`typography-ui-label` / `font-medium truncate`)
- `provider.id` mono `typography-micro text-muted-foreground`
- Model count: `typography-micro` with `text-muted-foreground` — e.g. `12 models`
- Auth status: if `provider.authenticated === true` → `Icon name="lock-2"` (or `shield-check` / `verified-badge`) `class="size-4 text-[var(--status-success)]"` plus optional `aria-label="Authenticated"`. Unauthenticated → `Icon name="lock-unlock"` muted OR no icon (cleaner). Locked = green (status.success). Alternative explored: `shield-check-fill` for authenticated, `shield` muted; final name to confirm after `bun run icons:generate` scan (Remix `RiLock2Line` → `lock-2`, `RiShieldCheckLine` → `shield-check`).
- Interaction: `hover:bg-interactive-hover`, `focus-visible:ring`, `border border-border/60`, `bg-[var(--surface-elevated)]` or `bg-card`, `rounded-xl`, `p-4`, `transition`. No primary/tint unless selected.
- Entire card is a button (`onClick => setSelectedProviderId(id)`), keyboard: Enter/Space, `aria-label="Open {label} provider, {count} models, authenticated"`

**Sorting**:

```ts
function sortProviders(providers: readonly PiProvider[]): PiProvider[] {
  return [...providers].sort((a, b) => {
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}
// If authenticated count > 0 and unauthenticated > 0, optional section headers.
// Within each partition the alphabetical sort already applies.
```

If search query present, sort after filter (so results still auth-first within query). Edge: authenticated group could be empty — just alphabetical.

**Search**:

- `Input` with `Icon name="search"` adornment, `placeholder="Search providers"` (`aria-label` same), `className="h-9 max-w-[24rem]"` (single h-9 size per controls.md).
- Debounced? Immediate filter is cheap (< 100 items); no debounce needed. Use `useDeferredValue` or raw state.
- Filters `label` + `id` case-insensitive, trimmed: `label.toLowerCase().includes(q) || id.toLowerCase().includes(q)`
- Empty results → `SettingsSection` helper: `No providers match “{q}”.` + clear button (ghost xs).
- Clear via `×` button inside input (like `SettingsView` search) and Escape key.

**Refresh**:

- Primary: `Button variant="ghost" size="icon" | size="sm"` with `Icon name="refresh"` (`animate-spin` when `refreshing`), `aria-label="Refresh providers"`; placed in `headerEnd` alongside search (mirrors `ProvidersSidebar` refresh).
- Calls `piClient.refreshProviders({ runtimeKey: getRuntimeKey() })`, then `useConfigStore.invalidateProviderCache()` + `loadProviders`, dispatch `pichamber:providers-refreshed` for consistency with existing event, setFailed false. On failure: inline `typography-meta text-[var(--status-error)]` + `reportSettingsSaveState('error')` if needed; keep existing cards (stale is better than empty).
- Loading initial: skeleton grid or `Loading…` centered muted (existing). Prefer `skeleton` cards (3× muted pulses) for grid polish.

**Add Custom**:

- “Other / Custom” currently a synthetic sidebar entry. In grid, add a dedicated affordance:
  - Option A (preferred): last card styled as dashed `border-dashed` with `Icon name="add"` + “Add custom provider” — clicking sets `selectedProviderId = PI_CUSTOM_PROVIDER_SELECTION`.
  - Option B: Header `Button variant="outline" size="sm"` “Add custom provider”.
  Keep both? Header button is discoverable; card is catalog-consistent. Recommend header `ghost` + dashed card as dual entry (card navigates same).

### 2.2 Detail state (provider selected)

Clicking card transitions *within the same Settings pane* to a detail view. No split pane.

```
SettingsPageLayout
  header: [ BackButton (arrow-left-s) ]  [Logo] Label  (+ authenticated pill)  [Disconnect]
          provider.id mono muted, error if any

  Section "Authentication" (SettingsSection, divider=false)
    - if authenticated: green check + "Connected"
    - else: API Key Input + Save Key + Reconnect (oauth)
    - ProviderLoginFlow (pending: authUrl/deviceCode/prompt Select/Input + Continue)

  Section "Available Models" (info prop)
    headerAction: [Refresh catalog | Show all / Hide all | Update provider]
    >8 models? Filter Input
    divide-y rows of ProviderModelRow (existing memo component)
    pagination Show 80 more
```

- Back: `Button variant="ghost" size="xs"` with `Icon name="arrow-left-s"` + “Back to providers” (or just icon on narrow pane). On click: `setSelectedProviderId(null)` → returns to grid. On mobile, hardware back should also map? Leverage `popstate` only if we push history (as Skills does for 3-stage mobile). Simpler: internal state, not history.
- Reuse existing `ProviderModelRow`, `ProviderLoginFlow`, `CustomProviderForm`, `thinking` persistence, hide toggles.
- `CustomProviderForm` when `isCreatingCustom || customEditing`: rendered inside same `SettingsPageLayout` with title “Custom provider” / “Edit custom provider” and cancel → `setSelectedProviderId(previous)` / `null`.
- Auth actions keep same `providerScope()` runtime scoping.

**Navigation state**: keep `usePiProviderSelectionStore.selectedProviderId` as source of truth. Grid shows when `null`; detail when string. Existing `ProvidersPage` already reads it; `ProvidersSidebar` writes it. New unified page both reads/writes. No new store needed.

### 2.3 States matrix

| State | Grid shows | Detail shows |
|---|---|---|
| loading providers null | `Loading…` skeleton cards | — |
| failed && !providers | `Unavailable` centered + `Refresh` | same |
| 0 providers | `No providers` empty + `Add custom provider` | — |
| search no match | `No providers match` inside grid area | — |
| provider has 0 models | card `0 models` | detail `No models match.` |
| authenticated vs not | sort partition, lock green vs muted | same auth row |

### 2.4 Responsiveness

- `SettingsPageLayout` already provides `@container`. Grid uses `@xl:` (36rem) and `@3xl:` (48rem) per layout.md — **not** viewport `sm:`/`lg:`.
- Cards: `p-4 gap-3` consistent, min-height ~110px. On narrow mobile (@container < 36rem) single column, comfortable tap target `min-h-[96px]`.
- Search input: full width on narrow (`w-full max-w-[24rem]`), `h-9`.
- Detail rows: `SettingsFieldRow` with `@xl:flex-row` already correct.

### 2.5 Accessibility

- Cards: `button type="button"` with `focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]`, `aria-label` includes provider label + model count + auth state.
- Auth icon has `aria-label="Authenticated"` or `aria-hidden` plus text alternative (`Connected`).
- Refresh button has `aria-label`.
- Search input has `aria-label="Search providers"` and `role="search"` if wrapped.
- Keyboard: Tab cycles cards → Enter/Space opens detail; Escape in search clears; Escape in detail goes back.

---

## 3. Architecture & Module Ownership

### Kind change

- `packages/ui/src/lib/settings/metadata.ts`: `providers` entry `kind: 'split' → 'single'`. This drives `SettingsView` layout decision (split vs single). This is a **cross-workspace contract**: every consumer of `getSettingsPageMeta` and `activePageMeta.kind` must handle the new value. Only `SettingsView.tsx` branches on it (3 places). Clearly intentional and visible.

### SettingsView changes (`packages/ui/src/components/views/SettingsView.tsx`)

- `SETTINGS_SPLIT_SIDEBAR_WIDTH = 280` remains for Projects/Skills etc.
- `renderPageSidebar(slug)` — remove `case 'providers': return <ProvidersSidebar …>` (delete). Keep switch; default returns null.
- `renderPageContent(slug)` — `case 'providers': return <ProvidersPage />` stays but now is the unified grid+detail page.
- `sortedFilteredPages` / `visiblePages` unaffected other than `kind`.
- Mobile `mobileStage` logic: currently deep-links to `page-sidebar` for `split` pages. After kind='single', opening providers on mobile goes straight to `page-content`. Remove any `settingsSlug === 'providers'` special cases (none exist today except sidebar render). Ensure `backButtonTargetsPageSidebar` check no longer references providers. The internal grid→detail back is handled inside `ProvidersPage`, not `SettingsView`.
- Net: providers behaves like `appearance`/`chat`: single scroll `SettingsPageLayout`.

### Provider files

| File | Action |
|---|---|
| `packages/ui/src/components/sections/providers/ProvidersPage.tsx` | **Major refactor** → unified grid + detail page (see §4). Keep `ProviderModelRow` memo, imports `piClient`, stores. Add `ProviderCard` subcomponent (or separate file). Add sorting/filter/search/refresh logic. Keep all `piClient.*` runtime-scoped logic verbatim (security/correctness). |
| `packages/ui/src/components/sections/providers/ProviderCard.tsx` | **New** — presentational card (props: provider, onClick). Keeps logo/auth/count rendering, theme tokens, Icon. Could be inline in ProvidersPage; separate for testability. |
| `packages/ui/src/components/sections/providers/ProviderDetail.tsx` | **New optional** — if we split detail extraction from `ProvidersPage` for readability. Alternatively keep as `ProviderDetailView` internal component in same file. |
| `packages/ui/src/components/sections/providers/ProvidersSidebar.tsx` | **Delete** after migration (or keep deprecated 1 release). Check `dead-code` after removal. |
| `packages/ui/src/components/sections/providers/CustomProviderForm.tsx` | Unchanged (still used inside detail/edit). |
| `packages/ui/src/components/sections/providers/*.test.*` | Keep/update; add new tests for sort/filter. |

### State & data

- No new Zustand store. Reuse `usePiProviderSelectionStore` for selected id + `providers` local state fetched via `piClient.listProviders/refreshProviders` (`providerScope() => ({runtimeKey: getRuntimeKey()})`). Keep both fetch paths: mount `listProviders` and `refreshProviders` on refresh.
- Also keep `useConfigStore` sync: `invalidateProviderCache()` + `loadProviders({source})` on refresh, plus `window.dispatchEvent(customEvent)` for other listeners (already done in sidebar). New grid should dispatch same event.
- Keep `thinking` defaults warm effect (`getSettings`) — preserved.

### Orchestration thin

- `SettingsView` stays thin; `ProvidersPage` owns domain logic (fetch, sort, filter, auth flow). No new bridge/proxy.

---

## 4. Component Detail

### 4.1 ProviderCard (new)

```tsx
interface ProviderCardProps {
  provider: PiProvider;
  onSelect: (id: string) => void;
}

export const ProviderCard: React.FC<ProviderCardProps> = ({ provider, onSelect }) => (
  <button
    type="button"
    onClick={() => onSelect(provider.id)}
    aria-label={`${provider.label} provider, ${provider.models.length} models${provider.authenticated ? ', authenticated' : ''}`}
    className={cn(
      "group flex flex-col gap-3 rounded-xl border border-border/60",
      "bg-[var(--surface-elevated)] p-4 text-left",
      "hover:bg-interactive-hover hover:border-border",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]",
      "transition-colors duration-150"
    )}
  >
    <div className="flex items-start justify-between gap-3">
      <ProviderLogo providerId={provider.id} className="size-8 shrink-0 rounded-md" />
      {provider.authenticated
        ? <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-success)]/10 px-2 py-0.5 typography-micro text-[var(--status-success)]">
            <Icon name="lock-2" className="size-3.5" aria-hidden />
            Connected
          </span>
        : <Icon name="lock-unlock" className="size-4 shrink-0 text-muted-foreground/60" aria-label="Not authenticated" />
      }
    </div>
    <div className="min-w-0">
      <div className="truncate typography-ui-label font-medium text-foreground">{provider.label}</div>
      <div className="truncate font-mono typography-micro text-muted-foreground">{provider.id}</div>
    </div>
    <div className="flex items-center gap-1.5 typography-micro text-muted-foreground">
      <Icon name="stack" className="size-3.5 opacity-70" aria-hidden />
      {provider.models.length} {provider.models.length === 1 ? 'model' : 'models'}
    </div>
  </button>
);
```

Tokens: `surface.elevated`, `interactive.hover`, `border`, `status.success`. No hardcoded hex. Icon names confirmed via `bun run icons:generate` — `lock-2` maps to `RiLock2Line`, `lock-unlock` to `RiLockUnlockLine`, `stack` to `RiStackLine` (used elsewhere). If `lock-unlock` missing, fallback to `lock` muted.

Variant: green lock solo (icon only) top-right: `<Icon name="lock-2" className="size-4 text-[var(--status-success)]" />`. Request says “green lock symbol maybe” — both badge and solo-icon satisfy.

### 4.2 ProvidersPage (refactored skeleton)

```tsx
export const ProvidersPage: React.FC = () => {
  const selectedProviderId = usePiProviderSelectionStore(s => s.selectedProviderId);
  const setSelectedProviderId = usePiProviderSelectionStore(s => s.setSelectedProviderId);
  const [providers, setProviders] = useState<readonly PiProvider[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [query, setQuery] = useState('');
  // ...plus existing auth/model/thinking state hoisted only when needed (detail)

  // fetch list on mount (runtimeKey scoped)
  // warm thinking defaults
  // refresh() and refreshCatalog() as before but setProviders + configStore sync + custom event

  // derived
  const sorted = useMemo(() => sortProviders(providers ?? []), [providers]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(p => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [sorted, query]);

  const selected = useMemo(() => providers?.find(p => p.id === selectedProviderId) ?? null, [providers, selectedProviderId]);
  const isCreatingCustom = selectedProviderId === PI_CUSTOM_PROVIDER_SELECTION;

  if (isCreatingCustom || customEditing) return <CustomProviderForm .../>;
  if (selected) return <ProviderDetailView provider={selected} onBack={() => setSelectedProviderId(null)} ... other props />;

  // Grid browse
  return (
    <SettingsPageLayout
      title="Providers"
      description="Manage model providers and authentication."
      headerEnd={
        <div className="flex items-center gap-2">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search providers" aria-label="Search providers" className="h-9 w-[18rem] max-w-[24rem] pl-8" />
            {query && <Button variant="ghost" size="xs" onClick={()=>setQuery('')} aria-label="Clear search" className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"><Icon name="close" className="size-4" /></Button>}
          </div>
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing} aria-label="Refresh providers" title="Refresh providers">
            <Icon name="refresh" className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          <Button variant="outline" size="sm" onClick={()=>setSelectedProviderId(PI_CUSTOM_PROVIDER_SELECTION)}>Add custom provider</Button>
        </div>
      }
    >
      <SettingsSection title="Providers" divider={false} settingsItem="providers.browse">
        {failed && !providers ? <p className="text-[var(--status-error)] typography-meta">Unavailable</p> : null}
        {providers === null && !failed ? <ProviderGridSkeleton /> : null}
        {filtered.length === 0 && providers !== null ? <p className="py-8 text-center typography-meta text-muted-foreground">{query ? `No providers match “${query}”` : "No providers"}</p> : null}
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
          {filtered.map(p => <ProviderCard key={p.id} provider={p} onSelect={setSelectedProviderId} />)}
          {/* dashed add card */}
          <button type="button" onClick={()=>setSelectedProviderId(PI_CUSTOM_PROVIDER_SELECTION)} className="flex min-h-[110px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 p-4 text-muted-foreground hover:bg-interactive-hover hover:text-foreground">
            <Icon name="add" className="size-5" /><span className="typography-ui-label">Add custom provider</span>
          </button>
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
```

Detail view reuses existing `ProviderModelRow`, `ProviderLoginFlow`, `Authentication` & `Available Models` sections with `SettingsSection`/`SettingsFieldRow` primitives, so flat-pages consistency is maintained *inside* detail.

**Alternative layout for authenticated group**: if we want explicit section headers:
```tsx
const authed = filtered.filter(p=>p.authenticated);
const unauthed = filtered.filter(p=>!p.authenticated);
{authed.length>0 && <h3 className={SETTINGS_GROUP_TITLE_CLASS}>Connected • {authed.length}</h3> + grid of authed}
{unauthed.length>0 && <h3 className={SETTINGS_GROUP_TITLE_CLASS}>Available • {unauthed.length}</h3> + grid of unauthed}
```
But sorted single grid is simpler and satisfies “authenticated should show up first”.

### 4.3 File map after

```
packages/ui/src/components/sections/providers/
  ProviderCard.tsx          // new
  ProviderDetail.tsx        // new (optional extraction)
  ProvidersPage.tsx         // rewritten (~300 lines browse + detail logic)
  CustomProviderForm.tsx    // unchanged
  custom-provider-form.ts   // unchanged
  // ProvidersSidebar.tsx  // deleted
```

---

## 5. Data & Integration

- `piClient.listProviders({runtimeKey})` & `piClient.refreshProviders({runtimeKey})` — already runtimeKey scoped; keep scope helper `providerScope = () => ({runtimeKey: getRuntimeKey()})`.
- `useConfigStore` — `invalidateProviderCache` + `loadProviders` on refresh (desktop/electron needs this).
- `window.dispatchEvent(new CustomEvent('pichamber:providers-refreshed', {detail: result}))` — preserve so any outside listener (still-mounted detail) updates.
- Error: `setFailed(true)` on refresh failure; keep previous `providers` (stale is authoritative fallback). Never set `providers = []` on fetch failure (invariant: fetch failure ≠ empty).
- Thinking per-model persistence: stays in detail view; uses `reportSettingsSaveState`.
- Custom providers: `setProviderModels`, `loginProvider`, etc., unchanged.

### Persisted/runtime invariants (pichamber-change-discipline)

- **No persisted schema change** — providers are daemon-derived, not UI persisted. `usePiProviderSelectionStore` holds only `selectedProviderId` (in-memory Zustand, not persisted). No migration.
- **Runtime-scoped caches**: ensure `getRuntimeKey()` check after async (as existing code does) to avoid stale runtime write.
- **One failed entity must not block unrelated entities**: `filtered` still renders authed providers even if one provider’s metadata fails.

---

## 6. Theme / Locale Compliance

- **theme-system**: use `Icon` sprite, `Button` variants (`ghost`, `outline`, `default`), tokens `surface.elevated`, `interactive.hover/selection/border`, `status.success`, `status.error`. No hardcoded colors. `Card` primitive not required (custom div gives precise padding); if `Card` is used, override `border shadow-none`.
- **Buttons**: refresh `variant="ghost" size="icon"`; search clear `variant="ghost" size="xs"`; add custom `variant="outline" size="sm"`; grid cards use plain `<button>` not `<Button>` to avoid button chrome (intentional card).
- **Icons**: `search`, `refresh`, `lock-2` (or `shield-check`), `lock-unlock`, `add`, `close`, `arrow-left-s`, `check`, `stack`. Verify names exist; else run `bun run icons:generate`. Never import `@remixicon/react` directly.
- **locale-ui-patterns**: every user-facing string via keys / constant? At minimum, no hardcoded accessibility labels without i18n path — use placeholders like `t('settings.providers.search.placeholder')` or existing constants style (project uses hard-coded English strings in many places; follow local precedent but prepare keys). Ensure `aria-label` strings are localized.

---

## 7. Settings Search Contract

Current `search.ts` entries for providers:

- `providers.connect`, `providers.custom`, `providers.auth`, `providers.connection-details`, `providers.models` — all indexed.
- Registry rule: dynamic entities (individual providers) **not** indexed. Grid search is *entity filter* inside page, not `Settings` global search. So no new `search.ts` items.
- However deep-link from global search `providers.connect` expects `selectedProviderId === null` (already done in `SettingsView.prepareSettingsSearchTarget` → `setSelectedProviderId(null)`). After refactor, grid browse with empty query is the connect surface → fine.
- Anchor: grid section uses `data-settings-item="providers.browse"` (add to `search.ts` only if we want it searchable; optional). Existing anchors `providers.auth`/`providers.models` stay in detail view.

---

## 8. Implementation Phases (incremental, minimal diff per phase)

### Phase 0 — Prep & audit (done in this doc)

- Confirm icon availability (`lock-2`, `shield-check`, `stack`) via `sprite.ts`.
- Snapshot current `ProvidersPage` behavior (auth flows, thinking, hide/show, custom form) as baseline.

### Phase 1 — Providers becomes single page (skeleton)

- Change `metadata.ts` `providers.kind` to `'single'`.
- Update `SettingsView.tsx`: drop `ProvidersSidebar` import + case, handle no-split layout, ensure desktop/mobile render path shows `ProvidersPage`.
- Refactor `ProvidersPage` to render **grid browse only** (no detail yet): fetch/sort/filter/search/refresh + `ProviderCard` grid + header actions. Keep `ProvidersSidebar.tsx` file but unused (or delete behind flag). Validate: `bun run type-check` (web + ui), `bun run lint`, manual smoke in browser (web & electron).

### Phase 2 — Drill-down detail

- Split `ProvidersPage` into browse vs detail branch keyed by `selectedProviderId`.
- Move existing Authentication + Models sections into `ProviderDetail` sub-component, preserving all handlers (`startLogin`, `submitPrompt`, `logout`, `persistThinkingForModel`, `toggleHiddenModel`, `modelFilter`, pagination, customEditing).
- Wire card click → `setSelectedProviderId(id)`, back → `setSelectedProviderId(null)`.
- Preserve `customEditing` / `PI_CUSTOM_PROVIDER_SELECTION` rendering path.
- Add `ProviderGridSkeleton`, empty, error states.
- Tests: add `providers.sort.test.ts` (sort contract) and component smoke for filter.

### Phase 3 — Polish & parity

- Header layout responsive (`@container`): search stacks on narrow pane, buttons wrap.
- Auth badge polish (green lock), model count icon, focus rings, high-contrast + long label truncation.
- Light/dark verification, overflow, long provider label (`truncate` + tooltip).
- Run `bun run icons:generate` if icon names changed; commit `sprite.ts`.
- Dead-code check: `bun run dead-code` should flag removed `ProvidersSidebar` export if still referenced.

### Phase 4 — Cleanup & docs

- Delete `ProvidersSidebar.tsx` (if kept interim), remove unused `PI_CUSTOM_PROVIDER_SELECTION` re-export path? Keep constant.
- Update `packages/ui/src/components/sections/providers/DOCUMENTATION.md` if exists, else note.
- Add brief note to `packages/ui/README.md` / sync docs about providers now single page.
- PR handoff per `CONTRIBUTING.md` + `.github/PULL_REQUEST_TEMPLATE.md`.

---

## 9. Validation Matrix (pichamber-change-discipline)

| Change kind | Risk | Minimum validation |
|---|---|---|
| Provider page refactor (exported component) | Module contract | `bun run type-check --filter ui`, focused Vitest for providers sort/filter, manual click-through (connect, disconnect, oauth pending, custom create/edit, thinking select, hide toggle) |
| `metadata.ts` kind switch & SettingsView branch | Cross-workspace contract (web/desktop/mobile consume shared metadata) | Workspace-wide `bun run type-check`, `bun run lint`, web build `bun run build --filter web`, electron smoke, mobile web surface check |
| New files (`ProviderCard.tsx`) | Local → module | `bun run dead-code`, snapshot/type-check |
| Icons/sprite | Generated asset | `bun run icons:generate` + `git diff sprite.ts` inspect, consumer type-check |
| No persisted schema | — | No migration test needed; verify downgrade leaves previous stored selectedId unbroken (in-memory only) |

Focused commands:

```bash
bun run type-check    # or bun run check / bun tsc --noEmit per package.json
bun run lint
bun run dead-code
bun run test --run packages/ui/src/components/sections/providers/*.test.ts
```

Runtime: launch `bun run dev:web` and verify split→single layout, search, refresh (success/failure), auth flows, custom provider round-trip. Electron: `bun run dev:electron` quick smoke. Mobile: resize to `@container` narrow, verify card columns collapse to 1.

---

## 10. Risks & Mitigations

- **Split→single breaks existing deep links / mobile history** → Mitigated: `resolveSettingsSlug('providers')` stays same; only layout changes. Deep-link stays valid; mobile goes direct to content (no intermediate sidebar list). Tested via `SettingsView` mobileStage effect.
- **Search vs Settings global search confusion** → Local provider filter is distinct from `SettingsView` global palette; both can coexist. Grid search does not interfere with `?q=` global search (global search remains in nav pane).
- **Cards violate flat-hierarchy skill** → Documented exception for entity catalog; detail still uses flat `SettingsSection` primitives.
- **Auth race (pending login polling)** → Keep existing 1s interval polling; ensure timer cleared on detail back / unmount (already does).
- **Runtime switch stale fetch** → Keep `scope.runtimeKey !== getRuntimeKey()` guard before writing state (already present).
- **Performance of large model lists** → Keep `visibleCap 80` + Show more pagination, `React.memo ProviderModelRow`.

---

## 11. Open Decisions (resolve before coding)

1. **Single sorted grid vs two section grids (Connected / Available)** — Proposal: single sorted grid (simpler), but if PM wants visual grouping, add thin section headers (`Connected • N` / `Available • N`) using `SettingsGroupTitle`. Recommend single for MVP, sections as follow-up.
2. **Auth icon choice** — `lock-2` green vs `shield-check` vs badge `Connected`. Provide Figma option; implementation swaps single Icon name.
3. **Custom provider card position** — header button always vs dashed card last vs both. Proposal: both for discoverability; card sorted last (not counted in sort).
4. **Detail back on browser back** — pushHistory for detail? Skills uses `popstate` for 3-stage mobile; providers detail could push, but simpler internal state avoids history complexity. Recommend internal until user asks for deep-link per provider (e.g. `providers/anthropic`).
5. **Projects consistency** — user mentioned Projects has same inconsistency; providers is pilot. Should we draft same grid pattern for Projects next? Keep out of scope for this PR.

---

## 12. File Inventory & LOC estimate

- Modified: `packages/ui/src/lib/settings/metadata.ts` (1 line), `packages/ui/src/components/views/SettingsView.tsx` (~15 lines removed), `packages/ui/src/components/sections/providers/ProvidersPage.tsx` (~260 → ~400 lines, net +140 but clearer split), `packages/ui/src/components/icon/sprite.ts` (generated).
- Added: `packages/ui/src/components/sections/providers/ProviderCard.tsx` (~80 lines), optional `ProviderDetail.tsx` (~200 lines if extracted).
- Deleted: `packages/ui/src/components/sections/providers/ProvidersSidebar.tsx` (134 lines).
- Net ~ -30 lines after extraction, + grid polish.

---

## 13. How to tell it's done

- `Settings → Providers` shows a single pane with `Providers` L1 title, search + refresh + Add custom in header, grid of cards (logo, label, id mono, model count, green lock if authed), authenticated first alphabetical.
- Typing in search instantly filters cards; clear restores sorted list; empty shows muted message.
- Refresh spins, re-fetches, preserves selection, invalidates config cache.
- Click card → detail with back arrow, logo+label header, auth + models sections (identical function to before), filter, thinking selects, hide toggles.
- Add custom provider card/button → same form as before, cancel returns to grid.
- No `ProvidersSidebar` rendered on desktop or mobile; `SettingsView` split width logic not applied to providers.
- Visual: light/dark/high-contrast, long names truncate, focus rings visible, hover only on interactive, container-query columns collapse 3→2→1.
- Tests pass: sort contract (authed first, alphabetical), filter contract, type-check/lint/dead-code clean.

---

## Appendix — Visual token cheatsheet for reviewer

- Page: `SettingsPageLayout` (`max-w-[840px]`, `@container`, `px-6 py-5 @3xl:px-10 @3xl:py-7`)
- Grid: `grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3`
- Card: `bg-[var(--surface-elevated)] border border-border/60 rounded-xl p-4 hover:bg-interactive-hover`
- Auth success: `text-[var(--status-success)] bg-[var(--status-success)]/10`
- Muted: `text-muted-foreground` / `text-muted-foreground/60`
- Focus: `focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]`

