import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposerAttachmentControls } from "./ComposerAttachmentControls";
import { ComposerAttachmentPickerInput } from "./ComposerAttachmentPickerInput";
import { ComposerDragOverlay } from "./ComposerDragOverlay";
import { ComposerFooter } from "./ComposerFooter";
import { ATTACHMENT_PICKER_INPUT_PROPS } from "./attachmentInputProps";
import { ATTACHMENT_ACCEPT } from "@/sync/attachment-files";

const FOOTER_BUTTON_CLASS = "foot";
const ICON_CLASS = "icon";

const renderAttachmentControls = (props: React.ComponentProps<typeof ComposerAttachmentControls>) =>
  renderToStaticMarkup(React.createElement(ComposerAttachmentControls, props));

const renderFooter = (isMobile: boolean) =>
  renderFooterWithWritableState({ isMobile, isAttachmentDisabled: false });

const renderFooterWithWritableState = (options: {
  isMobile: boolean;
  sessionId?: string | null;
  newSessionDraftOpen?: boolean;
  isSending?: boolean;
  isAttachmentDisabled?: boolean;
}) => {
  const {
    isMobile,
    sessionId = "session-1",
    newSessionDraftOpen = false,
    isSending = false,
    isAttachmentDisabled = false,
  } = options;
  return renderToStaticMarkup(
    React.createElement(ComposerFooter, {
      isMobile,
      isInline: false,
      alignToolsEnd: false,
      sessionId,
      newSessionDraftOpen,
      messageLength: 0,
      leadingExtra: React.createElement("span", { id: "model-picker" }, "MODEL-PICKER"),
      radius: "1rem",
      footerPaddingClass: "px",
      footerGapClass: "gap",
      footerIconButtonClass: FOOTER_BUTTON_CLASS,
      iconSizeClass: ICON_CLASS,
      sendIconSizeClass: "send",
      stopIconSizeClass: "stop",
      canSend: true,
      canAbort: false,
      hasContent: true,
      isSending,
      isAttachmentDisabled,
      onPickLocalFiles: () => {},
      onPrimaryAction: () => {},
      onQueueMessage: () => {},
      onAbort: () => {},
    }),
  );
};

/** Extract the attach `<button>` tag so disabled checks ignore attribute order. */
const getAttachButtonTag = (markup: string): string | null => {
  const labelIndex = markup.indexOf('aria-label="Add attachment"');
  if (labelIndex < 0) return null;
  const buttonStart = markup.lastIndexOf("<button", labelIndex);
  const tagEnd = markup.indexOf(">", labelIndex);
  if (buttonStart < 0 || tagEnd < 0) return null;
  return markup.slice(buttonStart, tagEnd + 1);
};

const isAttachDisabledInMarkup = (markup: string): boolean => {
  const tag = getAttachButtonTag(markup);
  return tag != null && /\bdisabled\b/.test(tag);
};

type FakeNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: unknown;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  [key: string]: unknown;
};

const makeNode = (tag: string, owner: Record<string, unknown>): FakeNode => {
  const node: FakeNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [],
    style: { setProperty() {}, getPropertyValue() { return ""; } },
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child: FakeNode) {
      node.childNodes.push(child);
      child.parentNode = node;
      return child;
    },
    insertBefore(child: FakeNode, ref: FakeNode) {
      const index = node.childNodes.indexOf(ref);
      if (index < 0) node.childNodes.push(child);
      else node.childNodes.splice(index, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: FakeNode) {
      const index = node.childNodes.indexOf(child);
      if (index >= 0) node.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    contains() { return false; },
    textContent: "",
    innerHTML: "",
  };
  return node;
};

const installFakeDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    nodeName: "#document",
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: (tag: string) => makeNode(tag, documentStub),
    createElementNS: (_ns: string, tag: string) => makeNode(tag, documentStub),
    createTextNode: (text: string) => ({ nodeType: 3, nodeName: "#text", textContent: text, parentNode: null }),
    getElementById: () => null,
  };
  const rootElement = makeNode("div", documentStub);
  (documentStub as Record<string, unknown>).body = rootElement;
  (documentStub as Record<string, unknown>).documentElement = rootElement;
  class ElementStub {}
  setGlobal("document", documentStub);
  setGlobal("window", globalThis);
  setGlobal("Element", ElementStub);
  setGlobal("HTMLElement", ElementStub);
  setGlobal("HTMLIFrameElement", ElementStub);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  );
  setGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  if (typeof (globalThis as Record<string, unknown>).ResizeObserver === "undefined") {
    setGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  }
  if (typeof (globalThis as Record<string, unknown>).MutationObserver === "undefined") {
    setGlobal("MutationObserver", class { observe() {} disconnect() {} });
  }
  const container = (documentStub.createElement as (tag: string) => FakeNode)("div");
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const getProps = (node: FakeNode): Record<string, unknown> | null => {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) return null;
  return (node as unknown as Record<string, Record<string, unknown>>)[key] ?? null;
};

const findAttachButton = (root: FakeNode): FakeNode | null => {
  const visit = (node: FakeNode): FakeNode | null => {
    const props = getProps(node);
    if (node.nodeType === 1 && props?.["aria-label"] === "Add attachment") return node;
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(root);
};

describe("composer mobile attachments", () => {
  test("mobile and desktop expose the same attach button chrome", () => {
    const mobile = renderAttachmentControls({
      footerIconButtonClass: FOOTER_BUTTON_CLASS,
      iconSizeClass: ICON_CLASS,
      handlePickLocalFiles: () => {},
      onOpenMobileSheet: () => {},
      isAttachmentDisabled: false,
    });
    const desktop = renderAttachmentControls({
      footerIconButtonClass: FOOTER_BUTTON_CLASS,
      iconSizeClass: ICON_CLASS,
      handlePickLocalFiles: () => {},
      isAttachmentDisabled: false,
    });

    for (const markup of [mobile, desktop]) {
      expect(markup).toContain('aria-label="Add attachment"');
      expect(markup).toContain('title="Add attachment"');
      expect(markup).toContain(`class="${FOOTER_BUTTON_CLASS}"`);
      expect(markup).toContain("#oc-add-circle");
    }
  });

  test("mobile footer places the attach button immediately left of the model picker", () => {
    const markup = renderFooter(true);
    const attachIndex = markup.indexOf('aria-label="Add attachment"');
    const modelIndex = markup.indexOf("MODEL-PICKER");
    expect(attachIndex).toBeGreaterThan(-1);
    expect(modelIndex).toBeGreaterThan(-1);
    expect(attachIndex).toBeLessThan(modelIndex);
    // No other labelled control sits between the attach button and the model picker.
    const attachEnd = markup.indexOf("</button>", attachIndex);
    expect(attachEnd).toBeGreaterThan(attachIndex);
    const between = markup.slice(attachEnd, modelIndex);
    expect(between).not.toContain("aria-label=");
  });

  test("desktop footer keeps the attach button left of the model picker", () => {
    const markup = renderFooter(false);
    const attachIndex = markup.indexOf('aria-label="Add attachment"');
    const modelIndex = markup.indexOf("MODEL-PICKER");
    expect(attachIndex).toBeGreaterThan(-1);
    expect(modelIndex).toBeGreaterThan(-1);
    expect(attachIndex).toBeLessThan(modelIndex);
  });

  test("activating the mobile button invokes the shared picker callback", async () => {
    const dom = installFakeDom();
    const root: Root = createRoot(dom.container);
    try {
      let calls = 0;
      await act(async () => {
        await root.render(
          React.createElement(ComposerAttachmentControls, {
            footerIconButtonClass: FOOTER_BUTTON_CLASS,
            iconSizeClass: ICON_CLASS,
            handlePickLocalFiles: () => {},
            isAttachmentDisabled: false,
            onOpenMobileSheet: () => {
              calls += 1;
            },
          }),
        );
      });

      const button = findAttachButton(dom.container as unknown as FakeNode);
      if (!button) throw new Error("mobile attach button not found");
      const onClick = getProps(button)?.["onClick"] as ((event: unknown) => void) | undefined;
      if (typeof onClick !== "function") throw new Error("mobile attach button has no onClick");

      act(() => {
        onClick({ preventDefault() {}, stopPropagation() {} });
      });
      expect(calls).toBe(1);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test("shared picker input accepts images and files and selects multiple", () => {
    expect(ATTACHMENT_PICKER_INPUT_PROPS.multiple).toBe(true);
    expect(ATTACHMENT_PICKER_INPUT_PROPS.type).toBe("file");
    expect(ATTACHMENT_PICKER_INPUT_PROPS.accept).toBe(ATTACHMENT_ACCEPT);

    // Images (including phone camera output) and general files share one picker action.
    expect(ATTACHMENT_ACCEPT).toContain("image/png");
    expect(ATTACHMENT_ACCEPT).toContain("image/jpeg");
    expect(ATTACHMENT_ACCEPT).toContain("application/pdf");
    expect(ATTACHMENT_ACCEPT).toContain("text/");
  });

  test("footer honors the authoritative attachment-disabled flag", () => {
    // `ChatInput` computes the flag from no session/draft or locked (sending
    // is included in the lock). The footer only applies it.
    for (const isMobile of [true, false]) {
      expect(
        isAttachDisabledInMarkup(
          renderFooterWithWritableState({ isMobile, isAttachmentDisabled: false }),
        ),
      ).toBe(false);
      const disabledMarkup = renderFooterWithWritableState({
        isMobile,
        isAttachmentDisabled: true,
      });
      expect(disabledMarkup).toContain('aria-label="Add attachment"');
      expect(isAttachDisabledInMarkup(disabledMarkup)).toBe(true);
    }
  });

  test("attachment controls honor the explicit attachment-disabled state on both triggers", () => {
    const mobileDisabled = renderAttachmentControls({
      footerIconButtonClass: FOOTER_BUTTON_CLASS,
      iconSizeClass: ICON_CLASS,
      handlePickLocalFiles: () => {},
      onOpenMobileSheet: () => {},
      isAttachmentDisabled: true,
    });
    const desktopDisabled = renderAttachmentControls({
      footerIconButtonClass: FOOTER_BUTTON_CLASS,
      iconSizeClass: ICON_CLASS,
      handlePickLocalFiles: () => {},
      isAttachmentDisabled: true,
    });
    expect(isAttachDisabledInMarkup(mobileDisabled)).toBe(true);
    expect(isAttachDisabledInMarkup(desktopDisabled)).toBe(true);

    const mobileEnabled = renderAttachmentControls({
      footerIconButtonClass: FOOTER_BUTTON_CLASS,
      iconSizeClass: ICON_CLASS,
      handlePickLocalFiles: () => {},
      onOpenMobileSheet: () => {},
      isAttachmentDisabled: false,
    });
    const desktopEnabled = renderAttachmentControls({
      footerIconButtonClass: FOOTER_BUTTON_CLASS,
      iconSizeClass: ICON_CLASS,
      handlePickLocalFiles: () => {},
      isAttachmentDisabled: false,
    });
    expect(isAttachDisabledInMarkup(mobileEnabled)).toBe(false);
    expect(isAttachDisabledInMarkup(desktopEnabled)).toBe(false);
  });

  test("drag overlay exposes a real disabled attach button", () => {
    // `useComposerDrop` stays enabled for a session/draft while locked, so
    // the overlay can render while attachment-disabled. The button must be
    // disabled instead of an enabled no-op (the picker callback also gates).
    const renderOverlay = (isAttachmentDisabled: boolean) =>
      renderToStaticMarkup(
        React.createElement(ComposerDragOverlay, {
          isInternalDrag: false,
          iconButtonBaseClass: FOOTER_BUTTON_CLASS,
          iconSizeClass: ICON_CLASS,
          radius: "1rem",
          isAttachmentDisabled,
          onPickLocalFiles: () => {},
        }),
      );
    const enabled = renderOverlay(false);
    expect(enabled).toContain('aria-label="Attach files"');
    const enabledTag = enabled.slice(enabled.indexOf("<button"), enabled.indexOf(">", enabled.indexOf("<button")) + 1);
    expect(enabledTag.includes('disabled=""')).toBe(false);
    const disabled = renderOverlay(true);
    expect(disabled).toContain('aria-label="Attach files"');
    const disabledTag = disabled.slice(disabled.indexOf("<button"), disabled.indexOf(">", disabled.indexOf("<button")) + 1);
    expect(disabledTag.includes('disabled=""')).toBe(true);
  });

  test("owned picker input renders the shared file contract", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ComposerAttachmentPickerInput, {
        inputRef: { current: null },
        onChange: () => {},
      }),
    );
    expect(markup).toContain('type="file"');
    expect(markup).toContain("multiple");
    expect(markup).toContain(`accept="${ATTACHMENT_ACCEPT}"`);
    expect(markup).toContain('class="hidden"');
  });

  test("owned picker input preserves ref and onChange behavior", async () => {
    const dom = installFakeDom();
    const root: Root = createRoot(dom.container);
    try {
      let refNode: unknown = null;
      let changes = 0;
      await act(async () => {
        await root.render(
          React.createElement(ComposerAttachmentPickerInput, {
            inputRef: (node: HTMLInputElement | null) => {
              refNode = node;
            },
            onChange: () => {
              changes += 1;
            },
          }),
        );
      });

      const input = (dom.container as unknown as FakeNode).childNodes.find(
        (child) => child.nodeType === 1,
      ) as FakeNode | undefined;
      if (!input) throw new Error("picker input not mounted");
      expect(refNode).toBe(input);

      const props = getProps(input);
      expect(props?.["type"]).toBe("file");
      expect(props?.["multiple"]).toBe(true);
      expect(props?.["accept"]).toBe(ATTACHMENT_ACCEPT);
      const onChange = props?.["onChange"] as ((event: unknown) => void) | undefined;
      if (typeof onChange !== "function") throw new Error("picker input has no onChange");
      act(() => {
        onChange({ target: { files: [], value: "" } });
      });
      expect(changes).toBe(1);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });
});
