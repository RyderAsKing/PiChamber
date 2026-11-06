// The PiChamber browser's "This device" route in the desktop app is a
// <webview>. This lets the renderer reach only those webviews.

/**
 * The webview with this id, or an error. Never returns the PiChamber window
 * itself or another kind of web contents.
 */
export const findBrowserWebview = (webContentsModule, BrowserWindowClass, value) => {
  const id = Number.isFinite(value) ? Math.trunc(value) : null;
  if (id === null || id < 0) throw new Error('webContentsId is required');
  const contents = webContentsModule.fromId(id);
  if (!contents || contents.isDestroyed()) throw new Error('WebContents not found');
  if (contents.getType() !== 'webview') throw new Error('Not a browser page');
  const host = contents.hostWebContents;
  if (!host || host.isDestroyed() || !BrowserWindowClass.fromWebContents(host)) throw new Error('Not a browser page');
  return contents;
};
