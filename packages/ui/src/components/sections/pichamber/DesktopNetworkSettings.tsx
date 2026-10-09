import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  getDesktopCloseToTray,
  getDesktopKeepAwake,
  getDesktopLaunchAtLogin,
  getDesktopMinimizeToTray,
  isDesktopLocalOriginActive,
  isDesktopShell,
  restartDesktopApp,
  setDesktopCloseToTray,
  setDesktopKeepAwake,
  setDesktopLaunchAtLogin,
  setDesktopMinimizeToTray,
} from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

/**
 * Desktop shell chrome (login item, tray, menu bar, keep-awake).
 *
 * Remote-access controls (LAN access + desktop UI password) used to live
 * here; they now live in Remote Access
 * (`@/components/sections/remote-access/DesktopLanAccessSettings`) so each
 * control exists in exactly one place.
 */
export const DesktopNetworkSettings: React.FC = () => {
  const isDesktop = isDesktopShell();
  const isLocalDesktop = isDesktop && isDesktopLocalOriginActive();
  const isMacDesktop = isLocalDesktop
    && typeof window !== 'undefined'
    && window.__PICHAMBER_PLATFORM__ === 'darwin';
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = React.useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = React.useState(false);
  const [isSavingLaunchAtLogin, setIsSavingLaunchAtLogin] = React.useState(false);
  const [minimizeToTraySupported, setMinimizeToTraySupported] = React.useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabled] = React.useState(false);
  const [isSavingMinimizeToTray, setIsSavingMinimizeToTray] = React.useState(false);
  const [closeToTraySupported, setCloseToTraySupported] = React.useState(false);
  const [closeToTrayEnabled, setCloseToTrayEnabled] = React.useState(true);
  const [isSavingCloseToTray, setIsSavingCloseToTray] = React.useState(false);
  const [savedMacMenuBarEnabled, setSavedMacMenuBarEnabled] = React.useState(true);
  const [draftMacMenuBarEnabled, setDraftMacMenuBarEnabled] = React.useState(true);
  const [keepAwakeSupported, setKeepAwakeSupported] = React.useState(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false);
  const [isSavingKeepAwake, setIsSavingKeepAwake] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error("Failed to load desktop settings");
        }

        const data = (await response.json().catch(() => null)) as null | {
          desktopMacMenuBarEnabled?: unknown;
        };
        if (cancelled) {
          return;
        }

        const macMenuBarEnabled = data?.desktopMacMenuBarEnabled !== false;
        setSavedMacMenuBarEnabled(macMenuBarEnabled);
        setDraftMacMenuBarEnabled(macMenuBarEnabled);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load desktop settings");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isDesktop) {
      setLaunchAtLoginSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopLaunchAtLogin();
      if (cancelled) {
        return;
      }
      setLaunchAtLoginSupported(status?.supported === true);
      setLaunchAtLoginEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  React.useEffect(() => {
    if (!isDesktop) {
      setMinimizeToTraySupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopMinimizeToTray();
      if (cancelled) {
        return;
      }
      setMinimizeToTraySupported(status?.supported === true);
      setMinimizeToTrayEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  React.useEffect(() => {
    if (!isDesktop) {
      setCloseToTraySupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopCloseToTray();
      if (cancelled) {
        return;
      }
      setCloseToTraySupported(status?.supported === true);
      setCloseToTrayEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  React.useEffect(() => {
    if (!isDesktop) {
      setKeepAwakeSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopKeepAwake();
      if (cancelled) {
        return;
      }
      setKeepAwakeSupported(status?.supported === true);
      setKeepAwakeEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  const isDirty = draftMacMenuBarEnabled !== savedMacMenuBarEnabled;
  const saveDisabled = isLoading || isSaving || !isDirty;

  const handleLaunchAtLoginToggle = React.useCallback(async () => {
    if (!launchAtLoginSupported || isSavingLaunchAtLogin) {
      return;
    }

    const nextValue = !launchAtLoginEnabled;
    setLaunchAtLoginEnabled(nextValue);
    setIsSavingLaunchAtLogin(true);
    setError(null);

    try {
      const status = await setDesktopLaunchAtLogin(nextValue);
      if (!status?.supported) {
        throw new Error("Launch at login is not supported on this system");
      }
      setLaunchAtLoginEnabled(status.enabled);
    } catch (cause) {
      setLaunchAtLoginEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : "Failed to update launch at login setting");
    } finally {
      setIsSavingLaunchAtLogin(false);
    }
  }, [isSavingLaunchAtLogin, launchAtLoginEnabled, launchAtLoginSupported]);

  const handleMinimizeToTrayToggle = React.useCallback(async () => {
    if (!minimizeToTraySupported || isSavingMinimizeToTray) {
      return;
    }

    const nextValue = !minimizeToTrayEnabled;
    setMinimizeToTrayEnabled(nextValue);
    setIsSavingMinimizeToTray(true);
    setError(null);

    try {
      const status = await setDesktopMinimizeToTray(nextValue);
      if (!status) {
        throw new Error("Failed to update system tray setting");
      }
      if (!status.supported) {
        throw new Error("System tray background mode is not supported on this system");
      }
      setMinimizeToTrayEnabled(status.enabled);
    } catch (cause) {
      setMinimizeToTrayEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : "Failed to update system tray setting");
    } finally {
      setIsSavingMinimizeToTray(false);
    }
  }, [isSavingMinimizeToTray, minimizeToTrayEnabled, minimizeToTraySupported]);

  const handleCloseToTrayToggle = React.useCallback(async () => {
    if (!closeToTraySupported || isSavingCloseToTray) {
      return;
    }

    const nextValue = !closeToTrayEnabled;
    setCloseToTrayEnabled(nextValue);
    setIsSavingCloseToTray(true);
    setError(null);

    try {
      const status = await setDesktopCloseToTray(nextValue);
      if (!status) {
        throw new Error("Failed to update close behavior");
      }
      if (!status.supported) {
        throw new Error("Closing to the system tray is not supported on this system");
      }
      setCloseToTrayEnabled(status.enabled);
    } catch (cause) {
      setCloseToTrayEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : "Failed to update close behavior");
    } finally {
      setIsSavingCloseToTray(false);
    }
  }, [closeToTrayEnabled, closeToTraySupported, isSavingCloseToTray]);

  const handleKeepAwakeToggle = React.useCallback(async () => {
    if (!keepAwakeSupported || isSavingKeepAwake) {
      return;
    }

    const nextValue = !keepAwakeEnabled;
    setKeepAwakeEnabled(nextValue);
    setIsSavingKeepAwake(true);
    setError(null);

    try {
      const status = await setDesktopKeepAwake(nextValue);
      if (!status?.supported) {
        throw new Error("Preventing sleep is not supported on this system");
      }
      setKeepAwakeEnabled(status.enabled);
    } catch (cause) {
      setKeepAwakeEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : "Failed to update keep awake setting");
    } finally {
      setIsSavingKeepAwake(false);
    }
  }, [isSavingKeepAwake, keepAwakeEnabled, keepAwakeSupported]);

  const handleSaveAndRestart = React.useCallback(async () => {
    if (!isDirty) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await runtimeFetch('/api/pi/ui-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          desktopMacMenuBarEnabled: draftMacMenuBarEnabled,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save desktop settings");
      }

      setSavedMacMenuBarEnabled(draftMacMenuBarEnabled);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error("Saved, but failed to restart app");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save desktop settings");
      setIsSaving(false);
    }
  }, [draftMacMenuBarEnabled, isDirty]);

  if (!isDesktop) {
    return null;
  }

  return (
      <SettingsSection title={"Desktop"}>
        <div className="space-y-3">
        {(launchAtLoginSupported || isMacDesktop || minimizeToTraySupported || closeToTraySupported || keepAwakeSupported) ? (
          <div className={SETTINGS_OPTION_STACK_CLASS}>
            {launchAtLoginSupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-launch-at-login"
                checked={launchAtLoginEnabled}
                onChange={(checked) => {
                  if (checked === launchAtLoginEnabled) return;
                  void handleLaunchAtLoginToggle();
                }}
                disabled={isSavingLaunchAtLogin}
                label={"Start PiChamber when you log in"}
                info={"Starts the app in the background without opening a window. Use the desktop status icon to open it."}
                ariaLabel={"Start PiChamber at login"}
              />
            ) : null}

            {isMacDesktop ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-mac-menu-bar"
                checked={draftMacMenuBarEnabled}
                onChange={setDraftMacMenuBarEnabled}
                disabled={isLoading || isSaving}
                label={"Show PiChamber in the menu bar"}
                info={"Requires an app restart. When off, PiChamber does not create the menu bar item or run its session, approval, and usage updates."}
                ariaLabel={"Show PiChamber in the macOS menu bar"}
              />
            ) : null}

            {minimizeToTraySupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-minimize-to-tray"
                checked={minimizeToTrayEnabled}
                onChange={(checked) => {
                  if (checked === minimizeToTrayEnabled) return;
                  void handleMinimizeToTrayToggle();
                }}
                disabled={isSavingMinimizeToTray}
                label={"Minimize to the system tray"}
                info={"Hides PiChamber in the system tray instead of leaving it in the taskbar when you minimize the window."}
                ariaLabel={"Minimize PiChamber to the system tray"}
              />
            ) : null}

            {closeToTraySupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-close-to-tray"
                checked={closeToTrayEnabled}
                onChange={(checked) => {
                  if (checked === closeToTrayEnabled) return;
                  void handleCloseToTrayToggle();
                }}
                disabled={isSavingCloseToTray}
                label={"Close to the system tray"}
                info={"Keeps PiChamber running in the system tray when you close the main window. Turn this off to quit the app when the window closes."}
                ariaLabel={"Close PiChamber to the system tray"}
              />
            ) : null}

            {keepAwakeSupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-keep-awake"
                checked={keepAwakeEnabled}
                onChange={(checked) => {
                  if (checked === keepAwakeEnabled) return;
                  void handleKeepAwakeToggle();
                }}
                disabled={isSavingKeepAwake}
                label={"Keep computer awake while PiChamber is running"}
                info={"Prevents system sleep so phones can keep reaching this app. The screen can still turn off."}
                ariaLabel={"Keep computer awake while PiChamber is running"}
              />
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}
        {isLocalDesktop ? (
          <div className="flex justify-start py-1.5">
            <Button
              type="button"
              size="xs"
              onClick={handleSaveAndRestart}
              disabled={saveDisabled}
              className="shrink-0 !font-normal"
            >
              {isSaving ? "Saving..." : "Save + Restart"}
            </Button>
          </div>
        ) : null}
        </div>
      </SettingsSection>
  );
};
