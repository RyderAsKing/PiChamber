import { MAX_CHOOSER_BYTES } from './uploads.js';

const MAX_DIALOG_MESSAGE = 4_000;
const MAX_PROMPT_TEXT = 10_000;

/**
 * A page's JavaScript dialogs and file choosers. Every viewer sees them and
 * any viewer may answer. With nobody watching, a dialog is answered at once
 * (leaving a page is allowed, anything else declined) so the page never
 * stalls on it.
 */
export const createTabPrompts = ({ broadcast, hasViewers, log = () => {} }) => {
  let dialog = null;
  let chooser = null;
  let chooserSeq = 0;

  const dialogMessage = () => ({ type: 'dialog', ...dialog.info });
  const chooserMessage = () => ({ type: 'file-chooser', id: chooser.id, multiple: chooser.multiple });

  const answer = async (handle, { accept, text }) => {
    try {
      if (accept) await handle.accept(typeof text === 'string' ? text.slice(0, MAX_PROMPT_TEXT) : undefined);
      else await handle.dismiss();
    } catch (error) {
      // The page closed or navigated first.
      log(`[server-browser] dialog: ${error?.message || error}`);
    }
  };

  const closeChooser = () => {
    if (!chooser) return;
    const { id } = chooser;
    chooser = null;
    broadcast({ type: 'file-chooser-closed', id });
  };

  return {
    bindPage(page) {
      page.on('dialog', (handle) => {
        const kind = handle.type();
        if (!hasViewers()) {
          void answer(handle, { accept: kind === 'beforeunload' });
          return;
        }
        dialog = {
          handle,
          info: {
            kind,
            message: String(handle.message() || '').slice(0, MAX_DIALOG_MESSAGE),
            defaultPrompt: kind === 'prompt' ? handle.defaultValue() || '' : '',
            url: page.url(),
          },
        };
        broadcast(dialogMessage());
      });
      page.on('filechooser', (handle) => {
        chooserSeq += 1;
        chooser = { id: chooserSeq, multiple: handle.isMultiple(), handle };
        broadcast(chooserMessage());
      });
    },

    /** What a newly attached viewer must see. */
    replay(viewer) {
      if (dialog) viewer.sendJson(dialogMessage());
      if (chooser) viewer.sendJson(chooserMessage());
    },

    async respondDialog({ accept, text }) {
      if (!dialog) return;
      const { handle, info } = dialog;
      dialog = null;
      broadcast({ type: 'dialog-closed' });
      await answer(handle, { accept: accept === true, text: info.kind === 'prompt' ? text : undefined });
    },

    /**
     * Gives the page the files (`{ name, mimeType, buffer }`) for chooser
     * `id`; none cancels it. Files the page cannot take send an
     * `upload-failed` notice.
     */
    async respondFileChooser({ id, files }) {
      if (!chooser || chooser.id !== id) return;
      const { handle, multiple } = chooser;
      closeChooser();
      if (!Array.isArray(files) || files.length === 0) return;
      const picked = multiple ? files : files.slice(0, 1);
      const failed = (message) => broadcast({ type: 'notice', kind: 'upload-failed', message });
      if (picked.reduce((total, file) => total + file.buffer.byteLength, 0) > MAX_CHOOSER_BYTES) {
        failed('Files for one upload must be under 50 MB together');
        return;
      }
      await handle.setFiles(picked).catch((error) => {
        log(`[server-browser] file chooser: ${error?.message || error}`);
        failed('The page did not take the files');
      });
    },

    /** A new document: a file chooser belongs to the page that asked. */
    documentChanged() {
      closeChooser();
    },

    /** The page is gone (closed, crashed, or replaced). */
    reset() {
      if (dialog) {
        dialog = null;
        broadcast({ type: 'dialog-closed' });
      }
      closeChooser();
    },
  };
};
