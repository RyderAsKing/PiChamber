import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AttachedFile } from "@/stores/types/sessionTypes";
import { useInputStore } from "@/sync/input-store";
import {
  captureWorktreeAttachments,
  resolveWorktreeSendAttachments,
  worktreeSendAttachmentIds,
} from "../worktreeAttachments";

const readyLocalFile = (overrides: Partial<AttachedFile> & { id: string }): AttachedFile => ({
  file: new File(["payload"], `${overrides.id}.txt`, { type: "text/plain" }),
  dataUrl: "data:text/plain;base64,cGF5bG9hZA==",
  mimeType: "text/plain",
  filename: `${overrides.id}.txt`,
  size: 7,
  source: "local",
  uploadState: { status: "ready", attachmentId: `opaque-${overrides.id}`, expiresAt: Date.now() + 60_000 },
  ...overrides,
});

/**
 * Real uploaded local files carry `dataUrl: ""` (see input-store
 * `addAttachedFile`: no base64 is retained in the draft). `FileReader` does
 * not exist in bun, so tests that exercise the byte-capture branch install
 * this faithful stand-in: it reads the real `Blob` bytes via `arrayBuffer`
 * and produces a `data:<blob.type>;base64,…` result, exactly what the
 * browser `FileReader` hands to `readFileAsDataUrl` before it rewrites the
 * mime to the attachment's `mimeType`.
 */
const installFaithfulFileReader = (): (() => void) => {
  const Original = (globalThis as unknown as { FileReader?: unknown }).FileReader;
  class FaithfulFileReader {
    result: string | null = null;
    error: unknown = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    async readAsDataURL(blob: Blob): Promise<void> {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const BufferCtor = (globalThis as unknown as {
          Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } };
        }).Buffer;
        let base64: string;
        if (BufferCtor) {
          base64 = BufferCtor.from(bytes).toString("base64");
        } else {
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          base64 = btoa(binary);
        }
        const type = (blob as File).type || "application/octet-stream";
        this.result = `data:${type};base64,${base64}`;
        queueMicrotask(() => this.onload?.());
      } catch (error) {
        this.error = error;
        queueMicrotask(() => this.onerror?.());
      }
    }
  }
  (globalThis as unknown as { FileReader: unknown }).FileReader = FaithfulFileReader;
  return () => {
    if (Original === undefined) delete (globalThis as unknown as { FileReader?: unknown }).FileReader;
    else (globalThis as unknown as { FileReader: unknown }).FileReader = Original;
  };
};

const resetInputStore = (): void => {
  useInputStore.setState({
    attachedFiles: [],
    stashedAttachmentsByDraft: {},
    activeAttachmentsDraftKey: null,
  });
};

describe("worktree send attachment handoff", () => {
  test("a single captured attachment still dispatches after the visible draft switches", async () => {
    const captured = await captureWorktreeAttachments([readyLocalFile({ id: "a" })]);

    // The composer resets to a fresh draft while the worktree builds: the
    // visible list is empty (or stashed) by the time dispatch runs.
    expect(resolveWorktreeSendAttachments(captured, [])).toEqual(captured);
    expect(resolveWorktreeSendAttachments(captured, [])).toHaveLength(1);
    expect(worktreeSendAttachmentIds(captured, [])).toEqual(["a"]);
  });

  test("multiple captured attachments dispatch while newer-draft files are excluded from detach scope", async () => {
    const captured = await captureWorktreeAttachments([
      readyLocalFile({ id: "a" }),
      readyLocalFile({ id: "b" }),
    ]);
    const newerDraftFile = readyLocalFile({ id: "c" });

    expect(resolveWorktreeSendAttachments(captured, [newerDraftFile]).map((file) => file.id)).toEqual(["a", "b"]);
    // Detach must remove only the files this send captured — never files
    // added to a newer draft while the worktree was building.
    expect(worktreeSendAttachmentIds(captured, [newerDraftFile])).toEqual(["a", "b"]);
  });

  test("the captured snapshot is immune to later live-list mutation", async () => {
    const live = [readyLocalFile({ id: "a" })];
    const captured = await captureWorktreeAttachments(live);
    live.push(readyLocalFile({ id: "late" }));

    expect(captured.map((file) => file.id)).toEqual(["a"]);
    expect(resolveWorktreeSendAttachments(captured, live).map((file) => file.id)).toEqual(["a"]);
  });

  test("the captured snapshot is immune to later live-object mutation", async () => {
    const live = [readyLocalFile({ id: "a", previewUrl: "blob:preview-a" })];
    const captured = await captureWorktreeAttachments(live);

    // Mutating the live wrapper and its uploadState after capture must not
    // reach the pending send. The store contract is immutable updates, but
    // the snapshot does not rely on it.
    live[0].filename = "renamed.txt";
    live[0].dataUrl = "data:text/plain;base64,bXV0YXRlZA==";
    (live[0].uploadState as { attachmentId: string }).attachmentId = "mutated";
    (live[0].uploadState as { expiresAt: number }).expiresAt = 0;

    expect(captured[0].filename).toBe("a.txt");
    expect(captured[0].dataUrl).toBe("data:text/plain;base64,cGF5bG9hZA==");
    expect(captured[0].uploadState).toMatchObject({ attachmentId: "opaque-a" });
    expect((captured[0].uploadState as { expiresAt: number }).expiresAt > Date.now()).toBe(true);
    expect(captured[0]).not.toBe(live[0]);
    expect(captured[0].uploadState).not.toBe(live[0].uploadState);
  });

  test("capture strips ephemeral preview URLs while keeping the dispatch fallback", async () => {
    const captured = await captureWorktreeAttachments([
      readyLocalFile({ id: "a", previewUrl: "blob:preview-a" }),
    ]);

    expect(captured[0].previewUrl).toBeUndefined();
    expect(captured[0].dataUrl.startsWith("data:")).toBe(true);
  });

  test("capture retains ready upload ids and the byte fallback dispatch needs after expiry", async () => {
    const captured = await captureWorktreeAttachments([readyLocalFile({ id: "a" })]);

    expect(captured[0].uploadState?.status).toBe("ready");
    expect(captured[0].uploadState).toMatchObject({ attachmentId: "opaque-a" });
    expect(typeof (captured[0].uploadState as { expiresAt?: unknown })?.expiresAt).toBe("number");
    // An upload ID that expires during the long worktree setup can only be
    // refreshed at dispatch when the local bytes were retained up front
    // (uploaded local files carry dataUrl: "").
    expect(captured[0].dataUrl.startsWith("data:")).toBe(true);
    expect(captured[0].filename).toBe("a.txt");
  });

  test("capture reads real local bytes for the empty-dataUrl branch and preserves upload state", async () => {
    const restore = installFaithfulFileReader();
    try {
      const bytes = "hello-bytes";
      const live = readyLocalFile({
        id: "real",
        file: new File([bytes], "real.txt", { type: "text/plain" }),
        dataUrl: "",
        size: bytes.length,
        previewUrl: "blob:preview-real",
        uploadState: { status: "ready", attachmentId: "opaque-real", expiresAt: Date.now() + 60_000 },
      });

      const captured = await captureWorktreeAttachments([live]);

      // Byte capture yields a usable data URL with the attachment's mime.
      expect(captured[0].dataUrl).toBe(`data:text/plain;base64,${Buffer.from(bytes).toString("base64")}`);
      // Upload identity survives capture for the dispatch-time refresh path.
      expect(captured[0].uploadState).toMatchObject({ attachmentId: "opaque-real" });
      expect((captured[0].uploadState as { expiresAt: number }).expiresAt).toBe(
        (live.uploadState as { expiresAt: number }).expiresAt,
      );
      expect(captured[0].filename).toBe("real.txt");
      expect(captured[0].previewUrl).toBeUndefined();
      // The live entry keeps its empty dataUrl; only the snapshot gains bytes.
      expect(live.dataUrl).toBe("");

      // The retained bytes round-trip through the same `fetch(dataUrl)`
      // step `routeMessage` uses to refresh an expired upload at dispatch.
      const refreshed = await (await fetch(captured[0].dataUrl)).blob();
      expect(await refreshed.text()).toBe(bytes);
    } finally {
      restore();
    }
  });

  test("an expired upload id stays refreshable because capture retained the empty-dataUrl bytes", async () => {
    const restore = installFaithfulFileReader();
    try {
      const bytes = "expired-payload";
      const expired = readyLocalFile({
        id: "expired",
        file: new File([bytes], "expired.txt", { type: "text/plain" }),
        dataUrl: "",
        size: bytes.length,
        uploadState: { status: "ready", attachmentId: "opaque-expired", expiresAt: Date.now() - 1_000 },
      });

      const captured = await captureWorktreeAttachments([expired]);

      // The id is expired, so `routeMessage` would take the dataUrl refresh
      // branch (`url.startsWith('data:')`) rather than reusing the id.
      expect((captured[0].uploadState as { status: string }).status).toBe("ready");
      expect((captured[0].uploadState as { expiresAt: number }).expiresAt <= Date.now()).toBe(true);
      expect(captured[0].dataUrl.startsWith("data:")).toBe(true);
      const refreshed = await (await fetch(captured[0].dataUrl)).blob();
      expect(await refreshed.text()).toBe(bytes);
    } finally {
      restore();
    }
  });

  test("capture rejects when a local file's bytes are unavailable so the send aborts before the draft switches", async () => {
    await expect(
      captureWorktreeAttachments([
        readyLocalFile({ id: "a", dataUrl: "", file: {} as File }),
      ]),
    ).rejects.toThrow("Attachment data is unavailable");
  });

  test("without a captured send the live list is used unchanged", () => {
    const live = [readyLocalFile({ id: "a" })];

    expect(resolveWorktreeSendAttachments(null, live)).toBe(live);
    expect(worktreeSendAttachmentIds(null, live)).toEqual(["a"]);
  });
});

describe("worktree send lifecycle against the attachment store", () => {
  beforeEach(resetInputStore);
  afterEach(resetInputStore);

  test("one captured file dispatches after a draft switch while a newer file survives detach", async () => {
    useInputStore.setState({
      attachedFiles: [readyLocalFile({ id: "a" })],
      activeAttachmentsDraftKey: "draft-source",
    });
    const captured = await captureWorktreeAttachments(useInputStore.getState().attachedFiles);

    // Draft switch stashes the pending send's file; the fresh draft gains a
    // newer file while the worktree builds.
    useInputStore.getState().activateAttachmentsDraft("draft-fresh");
    expect(useInputStore.getState().attachedFiles).toEqual([]);
    useInputStore.setState({ attachedFiles: [readyLocalFile({ id: "new" })] });

    // The long await expires the captured upload id, but dispatch still uses
    // the snapshot — never the live draft — and the retained bytes keep the
    // refresh path (`url.startsWith('data:')`) available.
    (captured[0].uploadState as { expiresAt: number }).expiresAt = Date.now() - 1;
    const toSend = resolveWorktreeSendAttachments(captured, useInputStore.getState().attachedFiles);
    expect(toSend.map((file) => file.id)).toEqual(["a"]);
    expect(toSend[0].dataUrl.startsWith("data:")).toBe(true);

    // Success detaches only the captured id from every slot; the newer draft
    // file survives wherever it lives.
    useInputStore.getState().detachAttachedFiles(worktreeSendAttachmentIds(captured, useInputStore.getState().attachedFiles));
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(["new"]);
    expect(useInputStore.getState().stashedAttachmentsByDraft["draft-source"] ?? []).toEqual([]);
  });

  test("many captured files detach without touching newer draft files", async () => {
    useInputStore.setState({
      attachedFiles: [readyLocalFile({ id: "a" }), readyLocalFile({ id: "b" })],
      activeAttachmentsDraftKey: "draft-source",
    });
    const captured = await captureWorktreeAttachments(useInputStore.getState().attachedFiles);

    useInputStore.getState().activateAttachmentsDraft("draft-fresh");
    useInputStore.setState({ attachedFiles: [readyLocalFile({ id: "new" })] });

    expect(
      resolveWorktreeSendAttachments(captured, useInputStore.getState().attachedFiles).map((file) => file.id),
    ).toEqual(["a", "b"]);
    useInputStore.getState().detachAttachedFiles(worktreeSendAttachmentIds(captured, useInputStore.getState().attachedFiles));
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(["new"]);
    expect(useInputStore.getState().stashedAttachmentsByDraft["draft-source"] ?? []).toEqual([]);
  });

  test("a failed old send restores its files for retry without overwriting a newer draft", async () => {
    const captured = await captureWorktreeAttachments([
      readyLocalFile({ id: "a" }),
      readyLocalFile({ id: "b" }),
    ]);

    // The fresh draft already holds one retried file plus a newer file.
    useInputStore.setState({ attachedFiles: [readyLocalFile({ id: "b" }), readyLocalFile({ id: "new" })] });
    const legacyRestore = useInputStore.getState().restoreAttachmentsForRetry(captured);
    expect(legacyRestore).toEqual({ ok: true, restoredCount: 1, totalCount: 3 });

    // Only the missing captured id returns; newer files keep order/identity.
    const visible = useInputStore.getState().attachedFiles;
    expect(visible.map((file) => file.id)).toEqual(["b", "new", "a"]);
    expect(visible[1].filename).toBe("new.txt");
  });

  test("a failed send with an empty live draft restores every captured file", async () => {
    const captured = await captureWorktreeAttachments([readyLocalFile({ id: "a" })]);
    useInputStore.setState({ attachedFiles: [] });

    const result = useInputStore.getState().restoreAttachmentsForRetry(captured);
    expect(result).toEqual({ ok: true, restoredCount: 1, totalCount: 1 });
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(["a"]);
  });

  test("duplicate captured ids restore once and preserve newer files", async () => {
    const captured = await captureWorktreeAttachments([
      readyLocalFile({ id: "a" }),
      readyLocalFile({ id: "a" }),
      readyLocalFile({ id: "b" }),
    ]);
    useInputStore.setState({ attachedFiles: [readyLocalFile({ id: "b" }), readyLocalFile({ id: "new" })] });

    const result = useInputStore.getState().restoreAttachmentsForRetry(captured);
    expect(result).toEqual({ ok: true, restoredCount: 1, totalCount: 3 });
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(["b", "new", "a"]);
  });

  test("exact 20-attachment limit succeeds transactionally", async () => {
    const visible = Array.from({ length: 18 }, (_, index) => readyLocalFile({ id: `v${index}` }));
    const captured = await captureWorktreeAttachments([
      readyLocalFile({ id: "a" }),
      readyLocalFile({ id: "b" }),
    ]);
    useInputStore.setState({ attachedFiles: visible, stashedAttachmentsByDraft: {} });

    const result = useInputStore.getState().restoreAttachmentsForRetry(captured);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.restoredCount).toBe(2);
      expect(result.totalCount).toBe(20);
    }
    expect(useInputStore.getState().attachedFiles).toHaveLength(20);
  });

  test("overflow makes no visible or stash mutation and reports counts", async () => {
    const visible = Array.from({ length: 19 }, (_, index) => readyLocalFile({ id: `v${index}` }));
    const stashed = [readyLocalFile({ id: "a" }), readyLocalFile({ id: "b" })];
    const captured = await captureWorktreeAttachments([
      readyLocalFile({ id: "a" }),
      readyLocalFile({ id: "b" }),
    ]);
    useInputStore.setState({
      attachedFiles: visible,
      stashedAttachmentsByDraft: { "draft-source": stashed },
      activeAttachmentsDraftKey: "draft-fresh",
    });
    const beforeVisible = [...useInputStore.getState().attachedFiles];
    const beforeStashed = { ...useInputStore.getState().stashedAttachmentsByDraft };

    const result = useInputStore.getState().restoreAttachmentsForRetry(captured);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('attachment-limit');
      expect(result.limit).toBe(20);
      expect(result.currentCount).toBe(19);
      expect(result.missingCount).toBe(2);
    }
    expect(useInputStore.getState().attachedFiles).toEqual(beforeVisible);
    expect(useInputStore.getState().stashedAttachmentsByDraft).toEqual(beforeStashed);
  });

  test("expired upload state and dataUrl fallback survive restore", async () => {
    const expired = readyLocalFile({
      id: "expired",
      uploadState: { status: "ready", attachmentId: "opaque-expired", expiresAt: Date.now() - 1_000 },
      previewUrl: "blob:preview-expired",
    });
    const captured = await captureWorktreeAttachments([expired]);
    useInputStore.setState({ attachedFiles: [] });

    const result = useInputStore.getState().restoreAttachmentsForRetry(captured);
    expect(result.ok).toBe(true);
    const restored = useInputStore.getState().attachedFiles[0];
    expect(restored.previewUrl).toBeUndefined();
    expect(restored.dataUrl.startsWith('data:')).toBe(true);
    expect(restored.uploadState).toMatchObject({ status: 'ready', attachmentId: 'opaque-expired' });
    expect((restored.uploadState as { expiresAt: number }).expiresAt <= Date.now()).toBe(true);
  });
});
