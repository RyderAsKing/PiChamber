import React from "react";

import { ATTACHMENT_PICKER_INPUT_PROPS } from "./attachmentInputProps";

type ComposerAttachmentPickerInputProps = {
  inputRef: React.Ref<HTMLInputElement>;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

/**
 * Hidden native file input for composer attachments.
 *
 * Owns the shared picker contract (`type=file` + `multiple` +
 * `ATTACHMENT_ACCEPT`) for web, desktop, hosted-mobile, and Capacitor so
 * callers cannot remove or override it. Always mounted: keeping it outside
 * remounting controls prevents an overlay/control remount from detaching the
 * native input while the OS picker is open. Writable-state gating lives on
 * the attach triggers and `handlePickLocalFiles`, not here.
 */
export function ComposerAttachmentPickerInput({
  inputRef,
  onChange,
}: ComposerAttachmentPickerInputProps) {
  return (
    <input
      ref={inputRef}
      {...ATTACHMENT_PICKER_INPUT_PROPS}
      className="hidden"
      onChange={onChange}
    />
  );
}
