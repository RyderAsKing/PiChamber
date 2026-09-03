import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SETTINGS_PAGE_METADATA,
  getSettingsNavIcon,
  getSettingsPageMeta,
  resolveSettingsSlug,
} from "@/lib/settings/metadata";
import { buildSettingsSearchResults } from "@/lib/settings/search";
import { pageOrder } from "@/components/views/settings/settingsViewHelpers";
import { parseRoute } from "@/lib/router/parseRoute";

const runtimeCtx = {
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  isDesktopLocalOrigin: false,
  isMac: false,
  isWindows: false,
  isLinux: false,
  isWindowsArm64: false,
};

const getPageTitle = (slug: string) =>
  getSettingsPageMeta(slug)?.title ?? slug;

describe("settings separation for snippets and prompt templates", () => {
  test("has separate navigation entries next to each other", () => {
    const slugs = SETTINGS_PAGE_METADATA.map((p) => p.slug);
    expect(slugs).toContain("snippets");
    expect(slugs).toContain("prompt-templates");
    const snippetIndex = pageOrder.indexOf("snippets");
    const promptIndex = pageOrder.indexOf("prompt-templates");
    expect(snippetIndex).toBeGreaterThanOrEqual(0);
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(Math.abs(promptIndex - snippetIndex)).toBe(1);
  });

  test("has separate icons and metadata", () => {
    expect(getSettingsPageMeta("snippets")?.title).toBe("Snippets");
    expect(getSettingsPageMeta("prompt-templates")?.title).toBe("Prompt templates");
    expect(getSettingsNavIcon("snippets")).toBeTruthy();
    expect(getSettingsNavIcon("prompt-templates")).toBeTruthy();
    expect(getSettingsNavIcon("snippets")).not.toBe(
      getSettingsNavIcon("prompt-templates"),
    );
  });

  test("restores direct prompt-templates slugs", () => {
    expect(resolveSettingsSlug("prompt-templates")).toBe("prompt-templates");
    expect(resolveSettingsSlug("?settings=prompt-templates")).toBe("home");
    expect(getSettingsPageMeta("prompt-templates")).not.toBeNull();
    const parsed = parseRoute(new URLSearchParams("settings=prompt-templates"));
    expect(parsed.settingsPath).toBe("prompt-templates");
    expect(resolveSettingsSlug(parsed.settingsPath)).toBe("prompt-templates");
  });

  test("uses single-pane routing for both pages (mobile back behavior)", () => {
    expect(getSettingsPageMeta("snippets")?.kind).toBe("single");
    expect(getSettingsPageMeta("prompt-templates")?.kind).toBe("single");
    const here = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(
      join(here, "../../components/views/settings/SettingsPageContent.tsx"),
      "utf8",
    );
    expect(content).toContain("case 'snippets'");
    expect(content).toContain("case 'prompt-templates'");
  });

  test("returns separate search results and anchors", () => {
    const snippetResults = buildSettingsSearchResults({
      query: "create snippet",
      runtimeCtx,
      getPageTitle,
    });
    expect(snippetResults.some((r) => r.page === "snippets")).toBe(true);
    expect(snippetResults.some((r) => r.page === "prompt-templates")).toBe(false);

    const promptResults = buildSettingsSearchResults({
      query: "create prompt template",
      runtimeCtx,
      getPageTitle,
    });
    expect(promptResults.some((r) => r.page === "prompt-templates")).toBe(true);
    expect(promptResults.some((r) => r.page === "snippets")).toBe(false);
  });

  test("snippets page performs no prompt-resource requests", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "../../components/sections/snippets/SnippetsPage.tsx"),
      "utf8",
    );
    expect(source).not.toContain("listResources");
    expect(source).not.toContain("resources.prompts");
    expect(source).not.toContain("Prompt templates");
  });

  test("prompt templates page does not access snippet CRUD", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "../../components/sections/prompt-templates/PromptTemplatesPage.tsx"),
      "utf8",
    );
    expect(source).not.toContain("useSnippetsStore");
    expect(source).not.toContain("/api/pi/snippets");
    expect(source).toContain("/name");
  });
});
