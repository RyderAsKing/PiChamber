# Composer

The chat composer: the prompt language, the editor that renders it, and
everything between typing and sending.

`ChatInput.tsx` (one directory up) is the orchestrator. It holds the composer's
own state and wires these modules together; it should not grow logic that
belongs to one of them. `ChatContainer` pins that chrome with `shrink-0` at the
bottom of the overflow-hidden chat column so the transcript scroller cannot
collapse the editor or the in-card footer.

## Layers

| Directory | Owns |
|---|---|
| `language/` | What the text *means*: `@` references, `/` and `#` tokens, markdown, and which picker a caret asks for |
| `editor/` | The CodeMirror view that renders the language and owns the caret |
| `state/` | Composer state with a lifecycle: drafts, mobile shell, history, popup placement, draft targeting |
| `submit/` | Turning what the user has into what gets sent |
| `attachments/` | Files: paths and drop payloads. `../../input-store.ts` owns preparation and upload state. |
| `ui/` | Presentation. Desktop (except mini-chat) uses a stacked card with `1.5rem` corners: editor on top, in-card toolbar with attachments + model picker (name kept visible) + thinking slider after the model name (when the model has levels besides `off`) + send. Dedicated mobile keeps that same stacked composer up at rest (no collapsed pill and no tap-to-grow); the + attach control is omitted so model and variant controls stay in the footer with their names always visible. New-session drafts show folder and local-branch pickers plus a `New worktree` toggle above, with starter chips below. On dedicated mobile, new-session drafts right-align a borderless worktree toggle above the branch, keep the folder at the left of the target row, and omit the changed-file summary. Existing sessions keep their changed-file summary below the read-only branch row. Its tooltip explains that worktrees start from the selected branch's latest commit without copying uncommitted changes. The folder picker includes linked worktrees beneath their owning project. Selecting one targets that directory without registering another project. Selecting a different branch records a draft intent; it never mutates Git from the picker. The first send confirms and completes checkout before creating the session. `New worktree` is an on-demand mode that treats the selected branch as `Start from`, derives a task name with the configured small model (with a local slug fallback), creates a new branch/worktree without changing the source checkout, waits for `setup-ready`, then creates the session and sends against its server-confirmed directory. Existing sessions show only a read-only current-branch label; they never load or display the branch list. Desktop keeps git workspace status on the right of that row (`justify-between`), while dedicated mobile places it below the branch for existing sessions and omits it from new-session drafts. If there is no branch label, git status stays on the row above the composer. Mini-chat keeps a one-line pill with the model picker under the composer. Folder icons in the picker use the sidebar muted grey. Composer thinking is Pi `thinkingLevels`, not OpenCode `model.variants`. Opening an existing session locks the composer to that Pi session's last used model and thinking variant so prompt cache identity stays with the transcript; the user can still change them manually. The chrome-less control after the model name opens a compact slider popover above the thinking trigger (centered on it, not flipped below the composer). The card contains the large discrete slider and a min/max legend; the current level stays on the trigger below. The trigger and hover tooltip reserve width for the longest level label so the popover does not drift when the current label changes. Choosing a level writes the composer override and, for an open session, live `sessions.setThinking`. Model picks remain local until send, so a thinking echo for the previous authoritative model must not overwrite the newer manual composer model. Unset/Default does not invent a level. Keyboard `mod+shift+t` and picker `←→` cycle Default plus the model's levels. |
| `text.ts` | How inserted text meets the text already there |
| `../../../../lib/dictation/` | Microphone capture, 16 kHz PCM streaming, reconnect/replay, and the final-only dictation state machine |

## The prompt language

`language/` is the single source of truth for composer syntax. Everything that
needs to know what a token means — highlighting, send-time resolution, and the
autocomplete triggers — goes through it.

**This is the invariant that matters most in this module.** Before it existed,
the `@` rule was written four times with divergent cleanup and the `/` rule
three times with different valid character sets, so a token could be painted as
a reference and then not resolve as one. Adding a construct meant finding every
copy.

- `mentions.ts` — `@` references. The `start..end` span is the reference
  itself and is what gets highlighted; in `see @a/b.ts,` the comma is sentence
  punctuation, not part of the file being referenced. Mentions are plain
  editable text: deleting a character edits the token and reopens the mention
  picker, the same way `/skill` tokens behave — not an atomic delete.
- `prefixTokens.ts` — `/command`, `/skill`, `#snippet`. Scanning is deliberately
  generous; **membership in the command, skill or snippet registry is the
  authority**, not the pattern. An unknown `/token` stays plain prose.
- `triggers.ts` — which picker a caret position asks for. Exactly one can be
  active, with precedence `command > skill > snippet > mention`.
- `tokenize.ts` — one pass producing every highlight range. Adding a construct
  to the language means adding it here, once.

## The editor

`editor/` wraps CodeMirror. The document is a plain string: `getValue()` is
exactly what gets sent, so nothing downstream serializes a rich document model
back into a prompt.

The composer previously painted a transparent `<textarea>` over a mirror
`<div>`. That restricted highlighting to styles which do not change glyph
advance width — colour, background, underline — because anything else made the
mirror drift out from under the caret. Bold and italic were impossible, and the
overlay was disabled outright on mobile, where wrapped text drifted anyway.
**Those constraints are gone**; adding a width-affecting style is now a
question of design, not of feasibility.

Selection rendering: every device runs CodeMirror's `drawSelection()` — it
keeps typing on the drawn-selection code path, and removing it makes
CodeMirror enforce cursor association on the native selection, which iOS
answers with severe input lag. Every device also layers
`composerNativeSelectionExtension` (`editor/theme.ts`) on top: it re-shows
the native selection, and — only while a range is selected — the native caret,
hiding the painted layers those replace. The native selection is the one that
shows for two reasons: the painted layer sits behind the content, so tokens
with their own background (inline code, fences) cover it completely; and
iOS's selection drag handles attach to the visible native selection and take
their colour from the caret, so a transparent caret means invisible handles.
The range-only caret scoping is load-bearing — a native caret visible while
typing makes WebKit re-render its caret UI after every keystroke, felt as
severe input lag. The selection tint comes from `--primary`, not the selection
token:
themes define `--interactive-selection` with its own alpha, so a translucent
mix of it is nearly invisible.

`composerLanguage.ts` retokenizes the whole document on every change. The
composer holds a prompt, not a source file: it is short enough that a full pass
is cheaper and far simpler than incremental mapping, and it keeps the editor
and the send path reading the same grammar.

## Ordering rules worth knowing

- A live standard-RPC `ctx.ui.setEditorText()` or `pasteToEditor()` event replaces the owning session's draft only while that session is the visible composer. The event is sequence-gated and applied once; reconnect snapshots never replay editor text over a newer local draft.
- `editor/ComposerEditor.tsx` forwards a click on the composer's padding by
  focusing the view *before* setting the selection: CodeMirror reveals its
  drawn caret through a class it only writes while applying an update, so the
  selection has to be the update that follows the focus.
- `submit/buildOutgoingMessage.ts` flattens queued messages, the composer text,
  synthetic context, attachments, and skill instructions into OpenCode's
  one-primary-plus-parts shape. The oldest queued message becomes primary.
- `state/useComposerDraft.ts` — a draft belongs to a (runtime, directory,
  session) identity. Writes are debounced while typing but forced at every edge
  where the page may stop running, because a pending timer is not a saved
  draft. Two orderings are load-bearing: the debounced write is skipped once
  while a draft is being restored, and a deleted draft's empty signature is
  recorded before a queued write could resurrect it.
- `state/useDraftTarget.ts` keeps directory selection separate from branch
  intent. `state/draftTargetProjects.ts` builds the target list and always keeps
  the identity-based "Don't work in a folder" target at literal `~`, even when
  the home directory is not registered or is also a registered project. While a new-session
  draft is open, it paints cached local branches for that exact directory and
  then revalidates them on every draft entry. The cache must not hide refs
  created by agents or terminals. The sidebar's active project remains
  authoritative unless the user explicitly selected the global target, which
  must not snap back to that active project. The draft welcome heading omits
  a folder name for that global target. A project or directory change clears
  the old branch intent. Existing sessions subscribe only to the current branch from
  lightweight Git status; they do not load a branch list and render no branch
  picker.
- A pending worktree intent is separate from branch-checkout intent and is scoped to runtime, owning project, source directory, and start ref. The first send captures the draft, derives a safe name, creates the worktree, and polls the server bootstrap phases. The composer is read-only while checkout/setup runs. It never materializes the session before `setup-ready`, never falls back to the source checkout, and keeps the draft intact on failure. The creation receipt carries the returned path into materialization; the session's returned directory is authoritative afterward. Creating from a linked worktree creates a peer worktree under the same project, and uncommitted source changes are not copied.
- A pending branch intent is scoped to runtime and normalized directory and is
  never written to the persisted last-draft target. Send preflights it against
  authoritative Git status and branches before displaying confirmation. Cancel
  consumes nothing. Checkout must finish and return the requested current
  branch before session materialization can proceed. The same confirmation
  lists every known working session in the selected project, including its
  worktrees, and warns that checkout may disrupt or conflict with their work.
  If another session starts while the dialog is open, the dialog updates and
  requires a fresh confirmation instead of opening a second dialog. Checkout
  failure preserves the draft, prompt, and attachments.
  PiChamber never auto-stashes, force-checks out, or rolls back a later branch
  change.

## Draft attachments

Picker, drop, and paste add cards before preparation completes. The composer renders one attachment strip inside the card: it wraps on wider layouts and scrolls horizontally on narrow layouts. Each card reads its own `preparing`, `uploading`, `ready`, or `failed` state from `input-store.ts`. Upload progress is determinate when the runtime transport reports a byte count. Failed and expired uploads stay visible with Retry and Remove actions.

Send and Queue require every draft attachment to be ready. The handlers repeat that check so keyboard submission cannot bypass it. Queueing detaches the cards without deleting their server uploads. Prompt dispatch keeps cards in place until Pi accepts the prompt; failure leaves them available for another attempt. Sent-message attachments use `MessageFilesDisplay` and do not share the draft-card lifecycle.

## Dictation

`ChatInput.tsx` captures the editor selection before recording and replaces only the editor area with the full-width recording controls. The footer stays mounted: icon-only Cancel and Done controls replace the microphone and send actions in the trailing action slot while dictation is active, with elapsed time beside them. The recorder area has one fixed height across permission, recording, reconnecting, and transcribing states, so status text cannot resize the composer. Audio levels stay outside React state. `ComposerVoiceVisualizer` coalesces them through `requestAnimationFrame` on a single canvas. Each frame shifts the existing bitmap left and paints one new level at the right edge, so older history moves left without rewriting a row of DOM nodes. Canvas dimensions update only through `ResizeObserver`, device-pixel ratio is capped at 2, and the resize history is bounded to 512 levels.

The server returns one authoritative transcript after Done. `ChatInput` pads it through `withInlineInsertionBoundaries`, inserts it at the captured range in one CodeMirror transaction, restores focus, and leaves sending to the user. Cancel, permission denial, disconnect, empty audio, model download, and transcription failure leave the draft and attachments unchanged.

## Mobile

`state/useMobileComposerShell.ts` and `state/useMobileViewportPin.ts` are
mostly not state machines but corrections for specific platform behaviors:
mobile browsers dismissing the keyboard before a tap's click lands, iOS
refusing programmatic focus outside a gesture, WebKit leaving the layout
viewport panned after the keyboard hides, overlay chains handing off through a
frame where nothing is open.

**Every timeout and `flushSync` in them has a reason recorded next to it, and
none of them is verifiable outside a real device.** Change them only against
hardware.

## Testing

The package has no DOM test environment, so coverage stops at the state and
logic layers: the language, the submit assembly, path and drop handling, text
splicing, message history, and the CodeMirror language extension at the
`EditorState` level.

Rendering, focus, keyboard behavior, IME and WKWebView are **not covered by
tests** and are verified by hand. Do not report a change to them as validated
on the strength of type-check and unit tests.

Run tests per file (`bun test <path>`): `mock.module` is process-global, so
suites that install module mocks are order-dependent.
