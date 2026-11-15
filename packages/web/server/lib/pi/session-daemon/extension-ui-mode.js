import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The mode extensions see by default: PiChamber hosts `ctx.ui.custom()`. */
export const DEFAULT_EXTENSION_MODE = 'tui';

/**
 * The `ctx.mode` a session's extensions are bound with, from the PiChamber
 * "Extension interface" setting (`extensionUi` in `<dataDir>/pi/settings.json`,
 * written by settings-store.js).
 *
 * - `terminal` (or unset): `tui`, so extensions draw their own terminal UI.
 * - `dialogs`: `rpc`, Pi's mode for frontends, so an extension that branches
 *   on `ctx.mode` uses Pi's standard dialogs instead. `custom()` stays hosted
 *   either way; this only changes what extensions are told.
 *
 * Read once per binding: Pi keeps a session's mode until the session is
 * created again (reload keeps it), so a change applies to sessions started
 * afterwards. A missing or unreadable file means the default; the settings
 * page reports an invalid file itself when it loads.
 */
export const resolveExtensionMode = ({ dataDir, readFile = readFileSync } = {}) => {
  if (!dataDir) return DEFAULT_EXTENSION_MODE;
  try {
    const settings = JSON.parse(readFile(join(dataDir, 'pi', 'settings.json'), 'utf8'));
    return settings?.extensionUi === 'dialogs' ? 'rpc' : DEFAULT_EXTENSION_MODE;
  } catch {
    return DEFAULT_EXTENSION_MODE;
  }
};
