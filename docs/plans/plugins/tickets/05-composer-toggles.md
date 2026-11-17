# 05 Slot: composer toggles

- `PluginComposerToggles` renders every enabled plugin's declared toggles
  after the model controls in `ComposerFooter` (desktop stacked, mobile
  scrolling strip; not in the inline mini composer).
- Chrome-less chip, icon + label, `aria-pressed`, selection tokens when on.
  Tooltip names the plugin. Writes go through the plugin store with an
  optimistic value that rolls back on failure.

Accept: render test (on/off/pending), keyboard and aria.
