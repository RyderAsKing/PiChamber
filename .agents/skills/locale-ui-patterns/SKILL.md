---
name: locale-ui-patterns
description: Use when creating or modifying PiChamber UI text, labels, buttons, placeholders, aria labels, empty states, toasts, dialogs, settings copy, navigation labels, or any user-facing strings.
---

# Locale & UI Copy Patterns

## Core Rule

PiChamber renders clean, direct, and user-friendly copy directly within components.

Use this skill for any React UI change that adds or edits visible text, accessible labels, placeholders, tooltips, toasts, dialogs, settings labels, navigation labels, or empty/error states.

## Tone & Style Guidelines

- **Concise & Direct**: Keep button labels, titles, and prompts short and action-oriented (e.g., "Save Changes", "Discard", "New Session").
- **Consistent Capitalization**: Use Sentence case for headings and titles, Title Case for buttons/actions if local precedent uses it, and lowercase for badges/status where established.
- **Accurate Terminology**: Use `PiChamber` for the app name and `Pi` for the underlying agent/session engine.
- **Accessible Text**: Always provide `aria-label` or `title` attributes on icon-only buttons or interactive elements lacking visible text.

## Component Usage Rules

- Use direct, inline strings in JSX, keeping copy co-located with the component.
- For dynamic strings, use clear template literals with proper pluralization and boundary handling.
- Handle singular vs plural forms explicitly rather than appending an awkward `(s)` suffix.

Good:
```tsx
const message = count === 1 ? '1 file changed' : `${count} files changed`;
```

Bad:
```tsx
const message = `${count} file(s) changed`;
```

## What Counts As UI Text

- Button and menu labels
- Settings labels and descriptions
- Placeholder text
- Tooltip content
- Dialog titles, descriptions, and actions
- Toast title, description, and action labels
- Empty, error, and loading states
- `aria-label`, `title`, and image `alt` text

## Exceptions

Do not alter:

- Protocol/tool acronyms: `MCP`, `SSE`, `WebSocket`, `API`
- Model/provider identifiers
- File paths, command names, and environment variable names
- Raw user content or streamed agent responses

## Review Checklist

- Clear, grammatically correct copy in changed UI files.
- Accessible `aria-label` on all icon buttons.
- Proper pluralization for counts.
- No dangling or broken placeholder interpolation.

