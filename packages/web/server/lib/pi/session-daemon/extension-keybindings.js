// Pi 1.5.0 passes `keyText()` and `keyHint()` to tool renderers and message
// renderers (`KeybindingHints`). The daemon builds those contexts itself, so it
// supplies both functions here.
//
// Pi's keybindings are terminal shortcuts, and PiChamber binds none of them: a
// row expands on click, not with `ctrl+o`. So `keyText()` returns no key, and
// `keyHint()` returns only the description, styled `muted` as in Pi. A Pi hint
// such as `(40 more lines, ctrl+o to expand)` then reads
// `(40 more lines, to expand)`.

/** `KeybindingHints` for extension renderers. Neither function throws. */
export function createExtensionKeybindingHints({ theme } = {}) {
  const keyText = () => '';

  const keyHint = (_keybinding, description) => {
    const text = String(description ?? '');
    return typeof theme?.fg === 'function' ? theme.fg('muted', text) : text;
  };

  return { keyText, keyHint };
}
