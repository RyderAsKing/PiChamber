# Theme Tokens And Examples

## Token Families

### Surface

| Token | Usage |
|---|---|
| `surface.background` | Main app background |
| `surface.elevated` | Inputs, cards, panels, popovers |
| `surface.muted` | Secondary backgrounds and sidebars |
| `surface.foreground` | Primary text |
| `surface.mutedForeground` | Secondary text and hints |
| `surface.subtle` | Subtle dividers |

### Text Levels

Three text levels, each readable on every surface:

| Class | Use |
|---|---|
| `text-foreground` | Primary text: titles, body, values |
| `text-muted-foreground` | Secondary text: labels, descriptions, session details |
| `text-subtle-foreground` | Tertiary text: timestamps, counts, hints, decorative separators |

The CSS generator holds `surface.mutedForeground` to WCAG AA (4.5:1) against
the background, sidebar, and elevated surfaces, raising it toward the
foreground only when a theme falls short, and derives `--subtle-foreground`
as one readable step below it. Do not fade text with alpha
(`text-muted-foreground/60`, `text-foreground/90`); alpha steps fall below
AA and drift between call sites. Use `opacity-*` only for disabled or
transitional states.

### Type Scale

| Class | Desktop | Mobile | Use |
|---|---|---|---|
| `typography-ui-header` | 15px | 14px | Panel and dialog titles |
| `typography-ui-label` | 14px | 13px | Row titles, menu items, buttons |
| `typography-meta` | 13px | 13px | Secondary lines, compact controls (composer pickers, `xs` buttons) |
| `typography-micro` | 12px | 12px | Timestamps, counts, badges, shortcuts |
| `typography-code` | 13px | 12px | Code and command output blocks |

These follow the user's font-size setting; fixed sizes (`text-xs`,
`text-[11px]`) do not, so prefer the tokens.

### Interactive

| Token | Usage |
|---|---|
| `interactive.border` | Default borders |
| `interactive.hover` | Hover on clickable elements only |
| `interactive.active` | Pressed interaction state |
| `interactive.selection` | Active/selected items |
| `interactive.selectionForeground` | Text on selection |
| `interactive.focusRing` | Focus indicators |

### Status

Use status colors only for actual feedback.

- `status.error`: errors and validation failures
- `status.warning`: cautions
- `status.success`: successful outcomes
- `status.info`: informational feedback

Each family may expose foreground, background, and border variants.

### Primary

- `primary.base`: primary CTA
- `primary.hover`: primary hover
- `primary.foreground`: content on primary

Primary means “act”; selection means “currently active.” Do not use primary to mark ordinary selected tabs or rows.

### Syntax

Use `syntax.*` only for code display: code backgrounds/text, keywords, strings, and diff highlights. Never use syntax colors for ordinary UI chrome.

## Usage

Prefer semantic utility classes when available:

```tsx
<div className="bg-[var(--surface-elevated)] text-foreground" />
<button className="hover:bg-interactive-hover" />
```

Use `useThemeSystem()` when a library/API requires actual color values:

```tsx
const { currentTheme } = useThemeSystem();

<Chart color={currentTheme.colors.status.error} />
```

## Common Patterns

### Input Area

```tsx
<div className="bg-[var(--surface-elevated)]">
  <textarea className="bg-transparent" />
  <div className="bg-transparent">...</div>
</div>
```

Input footers stay transparent over the elevated input surface.

### Active Item

```tsx
<button className={isActive
  ? 'bg-interactive-selection text-interactive-selection-foreground'
  : 'hover:bg-interactive-hover'
} />
```

### Error Feedback

```tsx
<div className="border border-[var(--status-error-border)] bg-[var(--status-error-background)] text-foreground">
  <Icon name="error-warning" className="text-[var(--status-error)]" />
  ...
</div>
<p className="text-[var(--status-error)]">Inline error text on a normal surface</p>
```

`--status-*-foreground` is the ink for a *solid* status fill (it also backs
`--destructive-foreground`). On the tinted `--status-*-background` it renders
near-black in many themes, so tinted alerts use `text-foreground` and mark
only the icon (or a short label) with `--status-*`.

### Neutral Card

```tsx
<section className="bg-[var(--surface-elevated)] text-foreground">
  <p className="text-muted-foreground">...</p>
</section>
```

## Wrong Patterns

```tsx
<div style={{ backgroundColor: '#F2F0E5' }} />
<button className="bg-blue-500" />
<div className="hover:bg-interactive-hover">Static content</div>
<Tab className="bg-primary">Active</Tab>
```

Use theme tokens, apply hover only to interactive elements, and distinguish selection from primary actions.
