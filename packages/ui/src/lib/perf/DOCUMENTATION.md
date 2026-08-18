# Performance overlay

Owns the in-app developer HUD for interactive jank debugging. It is not a
replacement for `profile:idle` / `profile:session`; those remain the source of
truth for before/after measurements.

## Enablement

Off by default. Local to this browser only (`localStorage.pichamber_perf_hud`),
never written through desktop settings.

Turn it on from Settings → General → Diagnostics, or with `?perf=1` /
`?perf=0`. The query param is applied once per page load.

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

## Privacy

Snapshots contain only aggregate counters, frame timings, and heap size.
They must not include session IDs, paths, credentials, or message content.
