# Docs authoring guide

`packages/docs` is the source of truth for PiChamber's public documentation.
Write for someone trying to complete a task, not for someone reading an
internal specification.

## Source layout

- `content/docs/*.mdx` contains English pages.
- `sidebar.config.json` contains the navigation tree.
- `README.md` describes local validation and the deployment boundary.
- `DEPLOYMENT.md` describes packaging and the cross-repository sync event.

English is the current source language. This repository currently carries
English pages only. Add a translation only after checking the active locale list
in `pichamber-website/apps/docs/astro.config.mjs` and confirming that a
maintainer will keep the translated page current. Do not copy legacy or
removed-runtime pages into a new locale.

## Voice and structure

- Lead with the task. The first sentence should tell the reader what the page
  helps them do.
- Keep one page focused on one job.
- Prefer common words. Define an internal term the first time it is necessary.
- Number sequential actions and start each step with a verb.
- End a procedure by describing what success looks like.
- Use bullets for options and numbered steps for actions.
- Keep list punctuation consistent within each list.
- Link to an existing page instead of duplicating its instructions.
- Use sentence case for headings.
- Keep commands copy-paste-ready. Use a placeholder only when the value is
  genuinely specific to the reader.

Example:

```mdx
1. Run `pichamber serve` in an interactive terminal.
2. Review the setup choices and confirm.
3. Open the URL printed by the command.

For non-interactive examples, pass the setup flags explicitly, for example
`pichamber serve --port 3000 --ui-password "choose-a-strong-password"`.
You should see the PiChamber session list. If it opens, the server is ready.
```

## Add a page

1. Create an `.mdx` file under `content/docs/`.
2. Add frontmatter with a title and description:

   ```mdx
   ---
   title: Remote access
   description: Connect to a PiChamber server from outside your local network.
   ---
   ```

3. Use route-safe names. `foo.mdx` becomes `/foo/`; `folder/index.mdx` becomes
   `/folder/`.
4. Add the page to `sidebar.config.json` when readers need to find it from the
   navigation.
5. Add an active-locale translation only when the website locale is maintained.
6. Run `bun run docs:validate`.

Every sidebar link must end in `/` and must map to an English MDX page. The
validator checks all MDX frontmatter and sidebar links.

## Sidebar entries

Keep labels short and task-oriented. Put translated labels in a `translations`
map on the same section or item. Never add a locale prefix to `link`.

```json
{
  "label": "Run PiChamber",
  "items": [
    {
      "label": "Connect devices",
      "link": "/connect-devices/"
    }
  ]
}
```

If the website has an active translation for the page, add the same filename
under that locale and translate its frontmatter title and description. Do not
translate product and technical names such as PiChamber, Pi, GitHub, PWA, Capacitor, macOS, or SSH. Do not translate commands, flags, paths, or
configuration keys.

## Images

Keep images beside the source page under `content/docs/`. Use relative paths so
the website build can optimize them:

```text
content/docs/install.mdx
content/docs/images/desktop.png
```

Every image needs useful alt text. Reuse an image across translations when it
contains no language-specific UI. If the screenshot contains translated UI,
store a copy under the matching locale folder.

Use the Astro `<Image>` component for light and dark variants. Name the files
`-light` and `-dark`, and use the website's `oc-light-only` and `oc-dark-only`
classes. `docs:validate` checks MDX, not image dimensions.

## Validate locally

Run from the repository root:

```bash
bun run docs:validate
```

This checks:

- every `.mdx` file has `title` and `description` frontmatter
- every sidebar link resolves to an English page

The validation command does not build the separate website repository.

## Sync to the docs website

Rendering and deployment happen in the separate `pichamber-website` repository.
After changing docs here:

1. run `bun run docs:validate`;
2. copy `packages/docs/content/docs/` recursively to
   `pichamber-website/apps/docs/src/content/docs/`;
3. map `packages/docs/sidebar.config.json` into the website Starlight config;
4. run the website repository's checks and build.

The `Docs Source` workflow packages this directory on docs changes, releases,
and manual dispatches. When `PICHAMBER_WEBSITE_REPO_TOKEN` is configured, it
sends a `repository_dispatch` event so the website can sync and deploy.
