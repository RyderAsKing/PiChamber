# PiChamber Docs Source

This package is the source-of-truth for PiChamber public docs content.

## Layout

- `content/docs/*.mdx` - English docs pages (source of truth)
- English is the source of truth. This repository currently carries English pages only. Add a translation only when the website has an active locale and a maintainer can keep it aligned with the current Pi-native product contract.
- `sidebar.config.json` - docs navigation structure for Starlight sidebar
- `CONTRIBUTING.md` - authoring guide for adding pages, sections, and translations
- `DEPLOYMENT.md` - release/manual packaging and sync trigger model

## Local validation

Run from repo root:

```bash
bun run docs:validate
```

This validates:

- frontmatter (`title`, `description`) exists for every MDX page
- sidebar links resolve to existing MDX routes

## Deployment model

This repo owns docs content.

Website rendering/deployment happens in `pichamber-website` (`apps/docs`).

Use `.github/workflows/docs-source.yml` to package docs source on release or manual trigger.
