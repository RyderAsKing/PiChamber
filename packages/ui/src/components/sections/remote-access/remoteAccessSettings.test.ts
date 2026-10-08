import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSettingsNavIcon,
  getSettingsPageMeta,
  resolveSettingsSlug,
} from "@/lib/settings/metadata";
import { buildSettingsSearchResults } from "@/lib/settings/search";
import { pageOrder } from "@/components/views/settings/settingsViewHelpers";

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath: string): string =>
  readFileSync(join(here, relativePath), "utf8");

const desktopCtx = {
  isWeb: false,
  isDesktop: true,
  isMobile: false,
  isDesktopLocalOrigin: true,
  isMac: false,
  isWindows: false,
  isLinux: false,
  isWindowsArm64: false,
};

const webCtx = {
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  isDesktopLocalOrigin: false,
  isMac: false,
  isWindows: false,
  isLinux: false,
  isWindowsArm64: false,
};

const mobileCtx = {
  isWeb: false,
  isDesktop: true,
  isMobile: true,
  isDesktopLocalOrigin: true,
  isMac: false,
  isWindows: false,
  isLinux: false,
  isWindowsArm64: false,
};

const getPageTitle = (slug: string) =>
  getSettingsPageMeta(slug)?.title ?? slug;

describe("remote access / servers settings contract", () => {
  test("registers both pages with icons and ordering", () => {
    expect(getSettingsPageMeta("remote-access")?.title).toBe("Remote Access");
    expect(getSettingsPageMeta("servers")?.title).toBe("Servers");
    expect(getSettingsNavIcon("remote-access")).toBeTruthy();
    expect(getSettingsNavIcon("servers")).toBeTruthy();
    expect(pageOrder).toContain("remote-access");
    expect(pageOrder).toContain("servers");
    expect(pageOrder).not.toContain("remote-instances");
  });

  test("keeps the hidden tunnel entry and a hidden legacy remote-instances entry", () => {
    expect(getSettingsPageMeta("tunnel")).not.toBeNull();
    expect(getSettingsPageMeta("tunnel")?.isAvailable?.(desktopCtx)).toBe(false);
    expect(getSettingsPageMeta("remote-instances")).not.toBeNull();
    expect(getSettingsPageMeta("remote-instances")?.isAvailable?.(desktopCtx)).toBe(false);
  });

  test("resolves legacy remote-instances deep links to remote-access", () => {
    expect(resolveSettingsSlug("remote-instances")).toBe("remote-access");
    expect(resolveSettingsSlug("remote-access")).toBe("remote-access");
    expect(resolveSettingsSlug("servers")).toBe("servers");
  });

  test("gates remote-access to desktop/web and hides it on mobile", () => {
    expect(getSettingsPageMeta("remote-access")?.isAvailable?.(desktopCtx)).toBe(true);
    expect(getSettingsPageMeta("remote-access")?.isAvailable?.(webCtx)).toBe(true);
    expect(getSettingsPageMeta("remote-access")?.isAvailable?.(mobileCtx)).toBe(false);
  });

  test("gates servers to the desktop shell only", () => {
    expect(getSettingsPageMeta("servers")?.isAvailable?.(desktopCtx)).toBe(true);
    expect(getSettingsPageMeta("servers")?.isAvailable?.(webCtx)).toBe(false);
    expect(getSettingsPageMeta("servers")?.isAvailable?.(mobileCtx)).toBe(false);
  });

  test("covers the required search keywords", () => {
    for (const keyword of ["remote", "access", "mobile", "phone", "pair", "qr", "device", "devices", "tailscale", "funnel", "lan", "network", "wifi", "password", "passkey"]) {
      expect(getSettingsPageMeta("remote-access")?.keywords).toContain(keyword);
    }
    for (const keyword of ["server", "servers", "instance", "switch", "connect", "import link", "host"]) {
      expect(getSettingsPageMeta("servers")?.keywords).toContain(keyword);
    }
  });

  test("routes moved controls to their new pages", () => {
    const lanPassword = buildSettingsSearchResults({
      query: "desktop ui password",
      runtimeCtx: desktopCtx,
      getPageTitle,
    });
    expect(lanPassword.some((r) => r.id === "sessions.desktop-ui-password" && r.page === "remote-access")).toBe(true);

    const lanAccess = buildSettingsSearchResults({
      query: "lan access",
      runtimeCtx: desktopCtx,
      getPageTitle,
    });
    expect(lanAccess.some((r) => r.id === "sessions.desktop-lan-access" && r.page === "remote-access")).toBe(true);

    const addDevice = buildSettingsSearchResults({
      query: "pair qr",
      runtimeCtx: desktopCtx,
      getPageTitle,
    });
    expect(addDevice.some((r) => r.page === "remote-access")).toBe(true);

    const tailscale = buildSettingsSearchResults({
      query: "tailscale",
      runtimeCtx: desktopCtx,
      getPageTitle,
    });
    expect(tailscale.some((r) => r.id === "remote-access.tailscale")).toBe(true);

    const importLink = buildSettingsSearchResults({
      query: "import link",
      runtimeCtx: desktopCtx,
      getPageTitle,
    });
    expect(importLink.some((r) => r.page === "servers")).toBe(true);
  });

  test("hides desktop-only server results on web", () => {
    const results = buildSettingsSearchResults({
      query: "import link",
      runtimeCtx: webCtx,
      getPageTitle,
    });
    expect(results.some((r) => r.page === "servers")).toBe(false);
  });

  test("every new registry id has a matching rendered anchor", () => {
    const sources = [
      readSource("RemoteAccessPage.tsx"),
      readSource("LocalNetworkRouteRow.tsx"),
      readSource("TailscaleRouteRow.tsx"),
      readSource("DevicesSection.tsx"),
      readSource("DesktopLanAccessSettings.tsx"),
      readSource("../pichamber/PasskeySettings.tsx"),
      readSource("../servers/ServersPage.tsx"),
    ].join("\n");
    for (const id of [
      "remote-access.client-auth",
      "remote-access.ways",
      "remote-access.lan",
      "remote-access.tailscale",
      "remote-access.tailscale-port",
      "remote-access.devices",
      "remote-access.security",
      "remote-access.passkeys",
      "sessions.desktop-ui-password",
      "sessions.desktop-lan-access",
      "servers.direct-hosts",
    ]) {
      expect(sources).toContain(`"${id}"`);
    }
  });

  test("general no longer renders the moved controls", () => {
    const page = readSource("../pichamber/PiChamberPage.tsx");
    expect(page).not.toContain("PasskeySettings");
    expect(page).not.toContain("desktop-lan-access");
    expect(page).not.toContain("desktop-ui-password");
  });

  test("desktop host switcher opens servers, labeled add server", () => {
    const switcher = readSource("../../desktop/DesktopHostSwitcher.tsx");
    expect(switcher).toContain("setSettingsPage('servers')");
    expect(switcher).not.toContain("setSettingsPage('remote-instances')");
    expect(switcher).toContain('{"Add server"}');
  });
});
