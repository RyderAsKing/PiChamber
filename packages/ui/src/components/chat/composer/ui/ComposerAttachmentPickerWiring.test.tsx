import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Consumer-wiring precedent mirrors
// `ChatMessage.assistantPartsPipeline.test.tsx`: mount the real component
// with `renderToStaticMarkup` and stub only the providers/Vite-only leaves.
// `useThemeSystem`/`useRuntimeAPIs` throw without their providers and
// `useProviderLogo` uses `import.meta.glob` (Vite-only).
mock.module("@/components/chat/chatSurfaceContext", () => ({
  useChatSurfaceMode: () => "default" as const,
}));
mock.module("@/contexts/useThemeSystem", () => ({
  useThemeSystem: () => ({ currentTheme: null }),
  useOptionalThemeSystem: () => null,
}));
mock.module("@/hooks/useRuntimeAPIs", () => ({
  useRuntimeAPIs: () => ({ git: {} }),
}));
mock.module("@/hooks/useProviderLogo", () => ({
  useProviderLogo: () => ({ src: null, onError: () => {}, hasLogo: false }),
}));

const { ChatInput } = await import("@/components/chat/ChatInput");
const { ATTACHMENT_ACCEPT } = await import("@/sync/attachment-files");

/** Find every `<input ...>` tag in static markup. */
const getInputTags = (markup: string): string[] => {
  const tags: string[] = [];
  let from = 0;
  while (true) {
    const start = markup.indexOf("<input", from);
    if (start < 0) break;
    const end = markup.indexOf(">", start);
    if (end < 0) break;
    tags.push(markup.slice(start, end + 1));
    from = end + 1;
  }
  return tags;
};

describe("ChatInput attachment picker wiring", () => {
  test("mounts the shared picker with the file contract", () => {
    // Renders the real ChatInput consumer (not the isolated picker
    // component): removing the picker from ChatInput must fail this test.
    const markup = renderToStaticMarkup(React.createElement(ChatInput, {}));

    const fileInputs = getInputTags(markup).filter((tag) => tag.includes('type="file"'));
    expect(fileInputs.length).toBe(1);

    const picker = fileInputs[0];
    expect(picker).toContain("multiple");
    expect(picker).toContain(`accept="${ATTACHMENT_ACCEPT}"`);
    expect(picker).toContain('class="hidden"');
  });

  test("disables the footer attach trigger with no session or draft", () => {
    // Default stores have no session and no open draft, so the authoritative
    // `isAttachmentDisabled` flag computed in ChatInput must disable the
    // footer trigger. Proves the flag is wired through ChatInput, not only
    // that the picker input exists.
    const markup = renderToStaticMarkup(React.createElement(ChatInput, {}));
    const labelIndex = markup.indexOf('aria-label="Add attachment"');
    expect(labelIndex).toBeGreaterThan(-1);
    const buttonStart = markup.lastIndexOf("<button", labelIndex);
    const tagEnd = markup.indexOf(">", labelIndex);
    expect(buttonStart).toBeGreaterThan(-1);
    expect(tagEnd).toBeGreaterThan(labelIndex);
    const tag = markup.slice(buttonStart, tagEnd + 1);
    // Check the real `disabled` attribute (`disabled=""`), not the
    // `disabled:` Tailwind variant in the button class.
    expect(tag.includes('disabled=""')).toBe(true);
  });
});
