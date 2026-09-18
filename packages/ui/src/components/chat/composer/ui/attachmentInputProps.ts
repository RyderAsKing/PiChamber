import { ATTACHMENT_ACCEPT } from "@/sync/attachment-files";

/**
 * Shared native picker contract for composer attachments.
 *
 * The hidden `<input type="file">` in `ChatInput` spreads this object so
 * web, desktop, hosted-mobile, and Capacitor all expose the same allowlist
 * and multi-select behavior. The preparation/upload pipeline in
 * `input-store.ts` owns everything after selection.
 */
export const ATTACHMENT_PICKER_INPUT_PROPS = {
  type: "file",
  multiple: true,
  accept: ATTACHMENT_ACCEPT,
} as const;
