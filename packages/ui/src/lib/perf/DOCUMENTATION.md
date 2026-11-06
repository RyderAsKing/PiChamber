# Performance overlay

Owns the in-app developer HUD for interactive jank debugging. It is not a
replacement for `profile:idle` / `profile:session`; those remain the source of
truth for before/after measurements.

## Enablement

Off by default. Local to this browser only (`localStorage.pichamber_perf_hud`),
never written through desktop settings.

Turn it on from Settings → General → Diagnostics, or with `?perf=1` /
`?perf=0`. The query param is applied once per page load.

## Interaction

Drag the HUD by its header to move it anywhere within the viewport. The position
is kept while the HUD remains mounted and resets to the top-right corner when it
is remounted; it is not persisted.

When the HUD is on, the existing stream, sync, and session-load counter
systems also record. Their independent localStorage flags still work for CLI
captures without mounting the overlay.

## Cost

Disabled: a boolean check on counter hot paths and no overlay, rAF, or
observers.

Enabled: one animation-frame sampler, a long-task observer when the browser
exposes it, and a 4 Hz DOM text update. The overlay does not subscribe to
session stores and must not React-render on the frame loop.

Leave the overlay off during CDP profile captures so it cannot become the
work being measured.

## Responsive-chat capture invariants

Production streaming comparisons must use the same historical-session and
dense-tool workload before and after a candidate change. Keep tool headers
visible in both captures. Hidden timeline/context/diff surfaces must contribute
no transcript subscriptions, and collapsed settled Task cards must contribute
no child-session hydration. Report development-server observations separately;
Vite/HMR connection and module-transform behavior is not production evidence.

## Privacy

Snapshots contain only aggregate counters, frame timings, heap size, and
on-demand viewport/layout geometry.
They must not include session IDs, paths, credentials, or message content.

## Layout diagnostics

Use **Measure layout** in the expanded overlay after closing Settings to
capture the affected screen. The copy button captures fresh layout measurements
alongside the performance snapshot. No browser console or native build is
required, so the same installed PWA can supply the measurements.

`viewportLayout.ts` owns this read-only capture. It records screen, layout and
visual viewport dimensions, resolved CSS viewport units and safe-area insets,
the measured `--oc-viewport-bottom-strip` (`null` when unset),
root/shell/composer/card/footer rectangles, composer padding and margin, and
bottom pseudo-overlay dimensions plus explicit runtime/keyboard class flags.
Absent elements produce `null`, not zero.
The reported gaps compare DOM coordinates only; they do not infer which part of
the physical display belongs to iOS. The numeric bottom margin includes any
configured Input Bar Offset without exporting unrelated settings.

There are no layout reads in the sampler or render loop. Captures run only on
Measure/Copy, remove their invisible CSS probe even on error, and are held in
memory until the overlay unmounts. They are not logged or sent to the server.
The controls preserve the editor's pointer focus so tapping Measure does not
itself request keyboard dismissal; real iOS keyboard behavior still needs device
validation. Copy failures leave any captured measurements visible.

`node scripts/test-pwa-layout.mjs --chrome /path/to/chrome` checks the collector
in a real browser against the fixture geometry, missing-composer handling,
probe cleanup on success/failure, and exclusion of prompt content.
