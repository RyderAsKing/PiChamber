# Docs source artifacts

`packages/docs` is the source of truth for PiChamber's task documentation. The repository validates and packages that source, but the current marketing website does not ingest or render the MDX collection.

## Workflow

`.github/workflows/docs-source.yml` runs on:

- pushes to `main` that change documentation source or validation tooling;
- published GitHub releases;
- manual `workflow_dispatch` runs.

The workflow:

1. runs `bun run docs:validate`;
2. creates `pichamber-docs-source-<sha>.tar.gz`;
3. uploads the archive as a workflow artifact for 14 days;
4. attaches the archive to a GitHub Release when the run has a release tag.

The archive preserves the source at the triggering commit. It does not deploy a website.

## Marketing website release updates

The separate private repository is `RyderAsKing/PiChamber-web`. Its download page uses a checked-in release manifest rather than these docs archives. Stable releases send that repository a `site_refresh_requested` event from `.github/workflows/release.yml`; release candidates do not.

A future documentation site can consume these archives or check out `packages/docs` at the supplied release tag. Until that renderer exists, publish documentation changes in the app repository and link readers to the source pages on GitHub.
