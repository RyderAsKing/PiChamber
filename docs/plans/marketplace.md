# Marketplace for Pi packages and PiChamber plugins

Status: built on `pichamber/extension-marketplace-planning`, 2026-11-18.

## Goal

Find, install, update and toggle Pi packages from Settings without hosting
a registry. Native plugins stay easy to turn on and never look like
something to install.

## Decisions

1. **Source.** npm's public search over packages with the `pi-package`
   keyword, the list pi.dev's gallery shows. The PiChamber server calls npm;
   the UI calls only `/api/pi/marketplace/*`. No README, images or tarball
   contents are read.
2. **Relevance.** npm search ranks but does not filter, and pads the tail
   with popular unrelated packages. The server keeps hits that contain a
   query word and stops paging at the first unrelated one.
3. **Featured list.** `packages/web/plugins/featured.json` ships with the
   app; the server refreshes the same file from the repo's `main` branch at
   most every 6 hours and caches it in the data directory. The newer list by
   `updated` wins. `hidden` doubles as moderation. The remote URL answers 404
   until this branch merges, so the built-in copy is used until then.
4. **PiChamber mark.** Every Pi package works in PiChamber, so the mark
   means enhanced for PiChamber (built with the plugin SDK), not support: the
   Enhanced for PiChamber filter and an Enhanced tag with the PiChamber mark. The
   `pichamber-plugin` keyword marks a list row (an author's claim). The
   package page confirms a `pichamber` block with a numeric `apiVersion`. Installed packages with the block get the Enhanced
   tag. Third-party packages load as plain Pi packages; PiChamber does not
   load a third-party UI half (deferred with custom UI).
5. **Native plugins.** Shown first on Extensions & Plugins under a Native
   plugins heading (no per-row tag there), each with a switch. Left out of every marketplace answer. A search word that
   starts a word of a native plugin's name or keywords shows it above the
   results under Built into PiChamber, with its switch.
6. **One place per package.** Installed packages show once, under Pi
   extensions → Packages, with version, Update and Remove. Plugins (native)
   sit above, Pi extensions below, separated by the section divider.
7. **Install.** A bare npm name only. A dialog warns that it runs as code
   with Pi's access and asks for Every project or This project only (trusted
   projects only). npm runs in the daemon outside Pi's settings lock, one
   install at a time; the settings write takes the lock afterwards. The
   request allows 10 minutes.
8. **Updates.** Offered for installed, unpinned npm packages whose version is
   behind npm's latest. Git and local packages get no Update button.

## Later

- Third-party plugin UI halves (needs the custom UI work).
- Update all, and update checks outside Settings.
- Git sources in Browse.
