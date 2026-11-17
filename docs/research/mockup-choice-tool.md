# Mockup-choice tool: what the Pi user means, and what PiChamber can do

Status: research (2026-11-17). No code was written. Claims say "verified" when read in source and "inferred" when they follow from source without being run.

## Short answer

- The user means OpenChamber's Agent Pages. The model calls `openchamber_render` with `awaitAnswer: true`, the chat draws the page inline, and the user's pick returns to the model as the tool result.
- It is an OpenChamber tool that OpenChamber's own plugin adds to OpenCode. It is not OpenCode's built-in `question` tool, which takes text options only.
- Plannotator is the closest Pi package the user found. It is a separate browser app, so it feels heavy and detached.
- Pi's dialogs (`select`, `confirm`, `input`, `editor`) are text only. A few Pi packages add text or ASCII previews. None draws images or HTML variants inline and waits for a pick.
- PiChamber already has `render_html` (shows a page, never waits) and `ctx.ui.select` (waits, text only). The model can call both, but nothing joins them.

## 1. The feature in OpenChamber and OpenCode

### The tool: `openchamber_render`

Verified. OpenChamber registers a tool named `openchamber_render` through its own plugin, `openchamber-agent-tool` (`packages/web/server/lib/agent-tool/runtime.js:67`, `:757-766`). The action behind it is `render.page` (`packages/web/server/lib/openchamber-control/actions.js:112`). It is on by default and can be switched off in Settings under OpenChamber Tools, "Charts and mockups" ([agent-pages.mdx](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/agent-pages.mdx)).

Input schema (`runtime.js`, `RENDER_PARAMETER_PROPERTIES`):

| Field | Meaning |
|---|---|
| `html` | One self-contained HTML document, at most 200,000 characters. For mockups and custom drawings. |
| `ui` | Instead of `html`: one openui-lang program. It draws the chat's own choice fields, inputs and buttons. The tool description says to prefer it for questions. |
| `title` | At most 120 characters. Falls back to the page's `<title>` or first heading. |
| `awaitAnswer` | Boolean. The call stays open until the user answers. |
| `answerLater` | Boolean. Returns at once, the page stays open, and the answer arrives later as a session message. |
| `share` | Object. Sends the page to teammates by link and PIN. Not combined with `awaitAnswer`. |

Send `html` or `ui`, not both (`render-page.js:242-247`).

### How the variants are given

Verified. A "variant" is not a first-class thing. The model writes one HTML page that holds all the options, such as three layouts side by side as option tiles. The `html` description names the base classes for this: `.oc-options` (a grid), `.oc-option` on a `<button>` with `aria-pressed`, and `.oc-button` (`runtime.js`, `RENDER_PAGE_AWAIT_DESCRIPTION`).

Images are supported. The page may name local PNG, JPEG, GIF or WebP files by absolute path in `src`, CSS `url()` or quoted script strings. The renderer inlines them before the page runs. Each file can be 10 MB and the page 25 MB in total (`render-page.js:13-43`, `runtime.js`, `RENDER_PAGE_HTML_DESCRIPTION`). Ready-made classes and theme variables (`--background`, `--primary`, `--chart-1` and so on) keep a page in the app's look.

### How the UI draws it

Verified. The page sits inline in the chat above the agent's reply, in an iframe with `sandbox="allow-scripts allow-forms"` (`packages/ui/src/components/chat/message/parts/HtmlRenderFrame.tsx:238`). It can open full screen and download as HTML. For `ui` pages the chat draws native controls (`UiPageFrame.tsx`, `uiBlocks/`).

### How the pick gets back to the model

Verified. For `html`, the page's button calls `openchamber.submit(data, summary)`. The injected script turns that into an MCP Apps `ui/message` request posted to the parent (`htmlRender.ts:274-277`). The frame accepts it only while the page is waiting and only during a real click (`HtmlRenderFrame.tsx:189-197`, `navigator.userActivation`). It sends the answer to the server through an authenticated route.

On the server, `pageAnswers.wait()` holds a promise per `sessionId` and `callId` (`render-page.js:154-208`). The tool call returns `{ title, answer: { answered: true, summary, data } }` plus a note telling the model to continue from the choice (`:103`, `:297`). `summary` is at most 500 characters and `data` at most 16,000 characters of JSON (`:10-11`). The answer is kept in the call's metadata, so a reload still shows the choice.

Failure paths are explicit:

- Decline returns `answered: false, reason: 'declined'` with a note not to pick for the user (`:109`).
- A chat message typed while waiting closes the page and returns `answered: false`. The note tells the model to continue from the message (`:105`).
- A message typed before the page appeared returns `chat-sent-earlier` at once (`:111`).
- A subagent session that nobody watches refuses `awaitAnswer` (`:210`).

### Free-text answers

Verified. Yes, three ways. A `ui` form adds a note field of its own, and the guidance says to read it in `data.note` (`uiBlocks/guidance.ts`, "the form adds a note field itself"). An `html` page can have any inputs it likes. The user can also just type in the chat, which ends the wait and reaches the model as a normal message ([agent-pages.mdx](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/agent-pages.mdx), "You can also answer in words").

### Answering later and sharing

Verified. `answerLater` keeps the page open across turns and restarts and delivers the answer as a message (`render-page.js:124`, `:268-276`). `share` sends the page to teammates (`:261-267`). Both came after the first version.

### When it was added

Verified in git history and changelogs of the OpenChamber repository.

| Step | Commit | Date | First release tag |
|---|---|---|---|
| `openchamber_render`: inline pages, mockups, charts | `cc3edcb4b` "let agents show charts, tables and mockups inline with a render tool" | 2026-10-15 | v2.3.3 ([changelog](https://github.com/openchamber/openchamber/blob/main/changelog/2.3.3.md), dated 2026-10-14) |
| `awaitAnswer`: ask the user to choose on a page | `2b94db847` "let agents ask the user to choose on a page" | 2026-10-16 | v2.4.0 |
| Local images, project-styled mockups | `334eacf4e` | 2026-10-16 | v2.4.0 (inferred from the date, tag not checked) |
| Ready classes in the app's look | `7941b9b1c` | 2026-10-19 | not checked |
| `answerLater` | `d3e56363f` (#6933) | 2026-11-14 | v2.7.2 |
| `share` to teammates | `8d188311a` | 2026-11-14 | v2.7.2 |
| Docs page "Agent Pages" | `343a7cf4f` | 2026-11-15 | not checked |

The commit message of `2b94db847` states the problem: pages could only show things, so the agent described options in text and the user answered in a new message.

### Other candidates, and which one matches

1. `openchamber_render` with `awaitAnswer`. It matches the post best: variants of a layout or image, shown inline, user picks, model gets the pick, like the ask-user tools.
2. OpenCode's built-in `question` tool. It is the text-only one the post compares against ("like the ask-user tools do"). Verified in `packages/core/src/tool/plugin/question.ts` and `packages/schema/src/question.ts` of the OpenCode repository: input is `questions[]`, each with `question`, `header`, `options[]` (`label`, `description`) and `multiple`. A "Type your own answer" option is added automatically. It has no HTML, image or preview field. It was added on 2026-01-07 (`e37fd9c105`, #7268). OpenChamber's own guidance sends quick clarifications to it and choices that set direction to `openchamber_render` (`uiBlocks/guidance.ts`).
3. OpenCode's experimental `artifact` tool (`packages/core/src/tool/plugin/artifact.ts`, first commit `8f0fc21e71`, 2026-10-30). It creates, reads, updates and deletes HTML artifacts from a file map. It has no ask-and-answer part. Inferred from reading the input schema only. It is not what the post describes.

No MCP server or skill is involved. OpenChamber's guidance text is a prompt convention that tells the model when to prefer a page over prose (`session-knowledge/ui-blocks-guidance.js`, not read in full).

## 2. What plannotator is

Verified in [backnotprop/plannotator](https://github.com/backnotprop/plannotator) at commit `993153f` (2026-11-17), mostly the root `README.md` and `apps/pi-extension/README.md`.

Plannotator is "a local, browser-based review surface for AI coding agents". It started as plan review and grew into code review, annotation of documents and HTML, and an Inbox. It supports many agents, Pi among them.

How it attaches to Pi: it is a Pi package, `@plannotator/pi-extension`, installed with `pi install npm:@plannotator/pi-extension` (`apps/pi-extension/package.json` lists `pi.extensions`). The extension adds plan mode (`--plan`, `Ctrl+Alt+P`), commands (`/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`, `/plannotator-inbox`), and tools: `plannotator_submit_plan`, a `plannotator` tool (off by default on Pi) and `plannotator_inbox` (off by default on Pi; it needs the `plannotator` CLI and a running Inbox).

How it shows things: it opens a browser tab or window. Plan review is a page where you approve, deny or annotate. The submit tool does not wait; it returns when the review opens, and your decision arrives later as a new message.

The part closest to the post is the Inbox. Its question syntax is a `:::question` block in markdown. Visual choices are written as `- [ ] A · Label — ![alt](path) what it means` (quoted as written there), so each option carries a picture (`apps/skills/core/plannotator/SKILL.md`, lines 188 and 256-280). Answers return as `Answer: <choice>`, `Other: <text>`, a note, or `Skipped`. The Inbox is a separate local app that must be started with `plannotator inbox`.

Why "dense/heavy" and "its own separate thing" (inferred from the above, not a statement by the author of the post):

- It covers a lot more than picking a variant: plan mode, code review, annotation, an Inbox, guided reviews, sharing.
- Answers happen in another browser window, not in the chat.
- It needs a CLI and a local server beyond the Pi package. Its own README says the Pi tool is off by default because Pi sends every tool definition with each request, about 800 tokens for the `plannotator` tool.
- The Pi package changes how a session works (plan mode, hidden phase messages).

## 3. What Pi offers today

### Extension UI calls

Verified in `@earendil-works/pi-coding-agent` 1.5.0 (the version PiChamber pins): `dist/core/extensions/types.d.ts:82-175` and `docs/extensions.md:2805-2925`.

| Call | What it does | Rich content |
|---|---|---|
| `select(title, options[], opts)` | Pick one string | No. Text only. |
| `confirm(title, message, opts)` | Yes or no | No. |
| `input(title, placeholder, opts)` | One line of text | No. |
| `editor(title, prefill)` | Multi-line text | No. |
| `custom(factory, options)` | Any TUI component with key focus, inline or overlay | Yes, in a real terminal. Pi's TUI has `Text`, `Markdown` and `Image` components (`docs/tui.md:34`). |
| `notify`, `setStatus`, `setWidget`, `setFooter`, `setHeader`, `setTitle`, `setWorkingMessage` and others | Display only | Widgets take string arrays or components. |

The dialog options are only `signal` and `timeout` (`types.d.ts:40-45`). `ctx.ui.form` does not exist in Pi. It is a PiChamber addition (see section 4).

In RPC mode only `select`, `confirm`, `input` and `editor` block and answer, and `custom()` is not available (`docs/rpc-extension-ui.md:7-25`). That is the mode PiChamber's "dialogs" setting presents.

### SDK examples

Verified in `examples/extensions/`. `question.ts` is a single question with options and descriptions plus a "Type something" row. `questionnaire.ts` is a multi-question flow with tabs (`examples/extensions/README.md:36-37`). Both draw with `ctx.ui.custom()` and refuse to run outside TUI mode. Neither shows an image or HTML.

### Published Pi packages

From `npm search` metadata and package readmes read on 2026-11-17. I did not install or run any of them, so what they draw is from their own readmes (not verified in running code).

Ask-user tools (text options, notes, free-text answers):

- `@juicesharp/rpiv-ask-user-question` (tool `ask_user_question`, up to four questions). An option can carry a markdown `preview`, such as an ASCII mockup, code or a diagram, shown beside the list in a bordered box.
- `@adeildo/pi-ask-questions`. Options with a preview of each, a note on any option, and a free-text answer.
- `@zhushanwen/pi-ask-user` (tool `ask_user`). Split-pane preview on wide terminals. The readme says the preview pane is plain text, not a markdown renderer.
- Others with the same idea: `@henryqw/pi-ask-question`, `@rwese/pi-question`, `@tduyng/pi-ask`, `@raidou/pi-ask-user`, `pi-agent-ask`, `pi-question-tool`.

Visual output, with no pick coming back (per their readmes):

- `pi-generative-ui` (tool `show_widget`): HTML widgets in a native window through Glimpse. The readme says widgets are display only, with no return channel.
- `sideshow`: the agent draws HTML, images and diffs on a live page in the browser. The html part can call `sendPrompt()` to post back to the thread.
- `pi-canvas`: a local web preview of HTML, SVG and Mermaid.
- `@blackbelt-technology/frontend-mockup-loop`: a skill plus tools such as `serve_mockup`, which serves a mockup directory with local and LAN URLs.
- `omp-artifacts`: for oh-my-pi, the agent queues HTML, images and PDFs for you to read in a viewer.
- `@thinkrail/pi-visualize`: a `visualize` tool that draws mermaid diagrams and option comparisons with box characters in the terminal.

So the gap the post describes is real in Pi: text and ASCII previews with a pick exist, and visual pages exist, but I found none that joins inline HTML or image variants with a blocking pick. Absence from a registry search is not proof. I did not search every registry or Pi's Discord.

## 4. What PiChamber has today

### Visuals plugin and `render_html`

Verified. `packages/web/plugins/visuals/extension.js` registers `render_html` (`:87-95`). Input: `title` (required), `html` or `path` (an `.html` file inside the project, exactly one), and optional `height`. `execute` validates and returns at once with `details: { title, html, height? }` (`:63-82`). It never waits for the user. It is off by default (`package.json` `defaultEnabled: false`) and the Visuals plugin is turned on in Settings, Extensions & Plugins.

The UI draws the page between the turn's activity and its reply (`turn.artifacts` slot, `packages/ui/src/plugins/DOCUMENTATION.md:237-275`). The frame is `sandbox="allow-scripts"` with an opaque origin, under a CSP of `default-src 'none'` with `img-src data: blob:` and no network unless the plugin's `allowNetwork` is on (`visuals/document.ts:45-50`). Theme variables are `--pc-bg`, `--pc-surface`, `--pc-fg`, `--pc-accent`, `--pc-c1` to `--pc-c5` and others.

What the page can send back to the host is only its height and link clicks (`document.ts:120`, `:167`; docs lines 239-258). There is no submit message. Images must be `data:` or `blob:`. There is no step that inlines a local file path, unlike OpenChamber.

While the call runs, the artifact shows only the title and size (`VisualsArtifact.tsx:17-24`). It draws the frame after the call completes.

### Dialogs that wait

Verified (`session-daemon/DOCUMENTATION.md:32`, `extensions.mdx:19`, `:307-330`). `ctx.ui.select`, `confirm`, `input` and `editor` publish an `extension.dialog` event, register as pending input (so every device sees "needs input"), and stay pending until the client answers through `extensions.respond`. PiChamber adds `ctx.ui.form(title, fields)` for `text`, `textarea`, `number`, `select` and `checkbox` fields, with at most 12 fields and 20 options. Gate it with `isPiChamber()`. All of these are text only.

`ctx.ui.custom()` draws a terminal screen in the chat, in Pi theme colours (`extensions.mdx:25`). In the "dialogs" mode it is not used. I found nothing showing that PiChamber's custom surface paints Pi `Image` components; `extension-custom-host.js:720` sets `kittyProtocolActive: false`. Treat images in a `custom()` surface as unsupported (inferred).

### Declarative cards and app surfaces

`pichamber.ui` cards take JSON components (`markdown`, `kv`, `list`, `table`, `progress`, `badges`, `code`) and up to eight action buttons that run extension commands (`extensions.mdx:193-290`). They have no image or HTML component.

`pichamber.app` entries are documented as sandboxed HTML surfaces whose elements can fire commands through `data-pichamber-command`. The docs say plainly that no client displays them yet (`extensions.mdx:333-362`). Verified from the docs; I did not grep the UI for a renderer.

### Daemon behaviour that helps

Verified. The daemon forwards a running tool's partial results as `session.tool.update` with `metadata` (`session-daemon.js:4451-4462`), and the Visuals artifact already reads the running call's `input` (`VisualsArtifact.tsx:19-23`). So a page could be drawn while a tool is still waiting. Today the artifact chooses not to.

### What a model can do now

In a PiChamber session with Visuals on, and any ask-user extension installed (the user said they already have one):

1. Call `render_html` once with a page showing variants A, B and C, labelled.
2. Call the ask-user tool, or `ctx.ui.select`, with "A", "B" and "C". The dialog appears in the dock and the model gets the label back. Free text works through the ask tool's own "other" or a chat message.

That works with no code change. It is two calls and relies on the model labelling the variants clearly. A pick cannot be a click on the variant itself. The page and the dialog are separate, so the page can scroll off while the dialog is open (inferred; not tested).

### What is missing

- A tool that shows variants and waits in one call, so the pick is the tool result.
- A way to pick by clicking the variant (no submit channel from the frame).
- Local image files in a page (`render_html` allows `data:` and `blob:` only).
- A running-state draw of the page for a tool that has not finished.
- In plain Pi: `render_html` shows nothing in a terminal, since the page is drawn only by PiChamber's UI.

## 5. Options to close the gap

I have not prototyped any of these.

### Option A. Do nothing in code, document the two-call pattern

- Model calls: `render_html` with the variants, then an ask-user tool or `select` with the labels.
- User sees: the page in the chat, then a dialog with the labels.
- Changes: docs, plus maybe a line in the Visuals tool description telling the model to label variants A, B, C and then ask.
- Plain Pi terminal: no. The page does not draw. The dialog still works.
- Main risk: the user must map a label to a page by eye, and a model may forget to ask. It does not match what OpenChamber does, so the post's user would likely still feel the gap.

### Option B. A new tool in the Visuals plugin that shows variants and waits

A tool such as `render_choices` (name is mine). Input: a question, and options each with `label`, an optional description, and `html` or `path` or an image path. It validates like `render_html`, then blocks until the user answers.

- What the model calls: one tool. The result is the chosen label, an optional note, or a declined or chat-interrupted marker, mirroring OpenChamber's notes.
- What the user sees: the options as cards side by side in the chat (stacked on a phone), each with Choose, and a note field. Full-window Expand per option is already a pattern in `VisualFrame`.
- Waiting mechanism, simplest first: the tool's `execute` calls `ctx.ui.select` with the labels, plus a note through `ctx.ui.input` or `ctx.ui.form` when running in PiChamber. The daemon's existing dialog path then carries the pick and the "needs input" badge on every device. The card is drawn from the running call's `input`. No daemon change.
- Click-to-pick on a card needs a submit path from the frame to `extensions.respond`: UI and daemon work, and a new trust boundary to design, as OpenChamber did with its click gate.
- Changes: Visuals plugin (new tool), UI (`visuals/` gallery drawn while running), docs and the plugin's tests. Optional daemon change for click-to-pick.
- Plain Pi terminal: the tool would still work as a text question if it falls back to `select` with labels and a path or description per option. The variants themselves would not draw.
- Main risk: a long-running tool whose page is drawn from `input` instead of a finished result is a new state for the artifact. The dock dialog and the cards could disagree (for example after a reload) unless the cards read the pending state as authoritative. See the repo's rules on live state.

### Option C. A PiChamber dialog with rich options: `ctx.ui.choose`

Extend the dialog protocol like `ctx.ui.form`: `ctx.ui.choose(title, options)` where each option may carry `html` or `image`. Any extension could use it, and Visuals or a new package would register a tool on top.

- What the model calls: a tool from an extension that uses `choose`.
- What the user sees: a modal or dock with variants and a Choose button each.
- Changes: daemon (`extension-bridge.js` event, validation, `extensions.respond`, pending-input index), shared protocol types, UI dialog, docs for extension authors. The largest change.
- Plain Pi terminal: `choose` is absent, so extensions must gate with `isPiChamber()` and fall back to `select`. Same pattern as `form`.
- Main risk: scope. It adds a second rich-content sandbox beside the Visuals frame, and a wider public API to keep stable. It only pays off if other extension authors will use it.

### Option D. Point the user at existing Pi packages

Suggest `@juicesharp/rpiv-ask-user-question` (ASCII or markdown previews in the terminal) or plannotator's Inbox (picture choices in a browser window) to the user, with no PiChamber change.

- Model calls: the package's own tool.
- User sees: a terminal dialog with a text preview, or a separate Inbox window with pictures.
- Changes: none in PiChamber, apart from a docs note. In PiChamber's "dialogs" mode, `custom()`-based dialogs may degrade to a plain `select` (inferred from `rpc-extension-ui.md:25` and `extensions.mdx:81-87`; I did not run the package).
- Plain Pi terminal: yes for the ask-user package. The Inbox needs its CLI and a browser.
- Main risk: it does not give inline image or HTML variants in the chat, which is what was asked for. It is fine for ASCII layouts only.

## Recommendation (my opinion)

Build Option B in two steps, and write Option A's two-call pattern into the Visuals tool description now, since it costs one line. Step one: a Visuals tool that draws the option cards from its running input and waits through `ctx.ui.select` (plus a note), which needs no daemon change and keeps the "needs input" badges and multi-device behaviour that already exist. Step two, only if testers want it: click-on-the-card picking through a guarded submit path.

I prefer B over C because the user asked for exactly this one flow, and B reuses the pending-dialog path and the Visuals sandbox. C is a platform change for a single use. A and D leave the user's actual complaint, seeing variants inline and picking one, unresolved.

## Things I could not verify

- The post itself. I searched GitHub issues and discussions with generic queries (Pi, PiChamber and OpenChamber) and found nothing. Where it was posted is unknown.
- Whether anyone has replied to it.
- Behaviour of the npm packages in section 3. I read their registry metadata and readmes only, and did not install or run them.
- Whether `openchamber_render` works as described in a running OpenChamber. I read source, tests exist in the repository, and I did not run it.
- First release tags for `334eacf4e`, `7941b9b1c` and `343a7cf4f`.
- Whether Pi's `Image` component draws inside PiChamber's `custom()` surface. The code hints it does not.
- Whether `pichamber.app` surfaces render anywhere. The docs say no client shows them. I did not grep the UI for one.
- How the dock dialog and a card behave together after a reload, since no such tool exists yet.

## Sources

OpenChamber (cloned shallow into `/tmp`, read only; repository [openchamber/openchamber](https://github.com/openchamber/openchamber), HEAD of 2026-11-17):

- `packages/docs/content/docs/agent-pages.mdx`
- `packages/web/server/lib/agent-tool/runtime.js` (tool registration, parameter descriptions)
- `packages/web/server/lib/agent-tool/DOCUMENTATION.md`
- `packages/web/server/lib/openchamber-control/render-page.js`, `actions.js`
- `packages/ui/src/components/chat/message/parts/HtmlRenderFrame.tsx`, `htmlRender.ts`
- `packages/ui/src/components/chat/uiBlocks/DOCUMENTATION.md`, `guidance.ts`
- `changelog/2.3.3.md`, `changelog/2.4.0.md`, `changelog/2.7.2.md`
- Commits `cc3edcb4b`, `2b94db847`, `334eacf4e`, `7941b9b1c`, `d3e56363f`, `8d188311a`, `343a7cf4f`

OpenCode ([sst/opencode](https://github.com/sst/opencode), cloned, HEAD `a9a35b4` of 2026-11-17):

- `packages/core/src/tool/plugin/question.ts`
- `packages/schema/src/question.ts`
- `packages/core/src/tool/plugin/artifact.ts`
- Commits `e37fd9c105`, `8f0fc21e71`

Plannotator ([backnotprop/plannotator](https://github.com/backnotprop/plannotator), cloned, HEAD `993153f`):

- `README.md`
- `apps/pi-extension/README.md`, `apps/pi-extension/package.json`
- `apps/skills/core/plannotator/SKILL.md`, `apps/skills/core/plannotator-inbox/SKILL.md`

Pi SDK (`node_modules/@earendil-works/pi-coding-agent` 1.5.0):

- `dist/core/extensions/types.d.ts`
- `docs/extensions.md`, `docs/tui.md`, `docs/rpc-extension-ui.md`
- `examples/extensions/README.md`, `question.ts`, `questionnaire.ts`

npm registry metadata and readmes, read through `npm search` and `npm view` (no installs): `@juicesharp/rpiv-ask-user-question`, `@adeildo/pi-ask-questions`, `@zhushanwen/pi-ask-user`, `pi-generative-ui`, `sideshow`, `pi-canvas`, `@blackbelt-technology/frontend-mockup-loop`, and the other names listed in section 3.

This repository:

- `packages/web/plugins/visuals/extension.js`, `package.json`
- `packages/ui/src/plugins/DOCUMENTATION.md`
- `packages/ui/src/plugins/visuals/document.ts`, `VisualFrame.tsx`, `VisualsArtifact.tsx`
- `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`, `session-daemon.js:4451`, `extension-custom-host.js:720`
- `packages/docs/content/docs/extensions.mdx`
- `packages/ui/src/lib/pi/protocol.ts`
