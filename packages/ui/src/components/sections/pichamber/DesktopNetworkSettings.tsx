import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import {
  getDesktopLanAddress,
  getDesktopKeepAwake,
  getDesktopLaunchAtLogin,
  getDesktopMinimizeToTray,
  isDesktopLocalOriginActive,
  isDesktopShell,
  restartDesktopApp,
  setDesktopKeepAwake,
  setDesktopLaunchAtLogin,
  setDesktopMinimizeToTray,
} from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
  SettingsStackedField,
  SETTINGS_ICON_BUTTON_CLASS,
} from '@/components/sections/shared/SettingsSection';

export const DesktopNetworkSettings: React.FC = () => {
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const isMacDesktop = isLocalDesktop
    && typeof window !== 'undefined'
    && window.__PICHAMBER_PLATFORM__ === 'darwin';
  const [savedValue, setSavedValue] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState(false);
  const [savedPassword, setSavedPassword] = React.useState('');
  const [draftPassword, setDraftPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [lanAccessActive, setLanAccessActive] = React.useState(false);
  const [lanAccessBlockedReason, setLanAccessBlockedReason] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = React.useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = React.useState(false);
  const [isSavingLaunchAtLogin, setIsSavingLaunchAtLogin] = React.useState(false);
  const [minimizeToTraySupported, setMinimizeToTraySupported] = React.useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabled] = React.useState(false);
  const [isSavingMinimizeToTray, setIsSavingMinimizeToTray] = React.useState(false);
  const [savedMacMenuBarEnabled, setSavedMacMenuBarEnabled] = React.useState(true);
  const [draftMacMenuBarEnabled, setDraftMacMenuBarEnabled] = React.useState(true);
  const [keepAwakeSupported, setKeepAwakeSupported] = React.useState(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false);
  const [isSavingKeepAwake, setIsSavingKeepAwake] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lanAddress, setLanAddress] = React.useState<string | null>(null);

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
          desktopLanAccessEnabled?: unknown;
          desktopUiPassword?: unknown;
          desktopLanAccessActive?: unknown;
          desktopLanAccessBlockedReason?: unknown;
          desktopMacMenuBarEnabled?: unknown;
        };
        if (cancelled) {
          return;
        }

        const enabled = data?.desktopLanAccessEnabled === true;
        const password = typeof data?.desktopUiPassword === 'string' ? data.desktopUiPassword : '';
        setSavedValue(enabled);
        setDraftValue(enabled);
        setSavedPassword(password);
        setDraftPassword(password);
        setLanAccessActive(data?.desktopLanAccessActive === true);
        setLanAccessBlockedReason(
          typeof data?.desktopLanAccessBlockedReason === 'string' ? data.desktopLanAccessBlockedReason : null
        );
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
    if (!isLocalDesktop) {
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
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
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
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
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
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop || !draftValue) {
      setLanAddress(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const address = await getDesktopLanAddress();
      if (!cancelled) {
        setLanAddress(address);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftValue, isLocalDesktop]);

  const isDirty = draftValue !== savedValue
    || draftPassword !== savedPassword
    || draftMacMenuBarEnabled !== savedMacMenuBarEnabled;
  const currentPort = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    const portSource = runtimeApiBaseUrl || window.location.href;
    let parsed = 0;
    try {
      parsed = Number(new URL(portSource).port);
    } catch {
      parsed = Number(window.location.port);
    }
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);
  const lanUrl = draftValue && lanAccessActive && lanAddress && currentPort ? `http://${lanAddress}:${currentPort}` : null;
  const lanRequiresPassword = draftValue && !draftPassword.trim();
  const lanBlockedByMissingPassword = savedValue && !lanAccessActive && lanAccessBlockedReason === 'missing-password';
  const saveDisabled = isLoading || isSaving || !isDirty || lanRequiresPassword;

  const handlePasswordChange = React.useCallback((value: string) => {
    setDraftPassword(value);
    if (!value.trim()) {
      setDraftValue(false);
    }
  }, []);

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
          desktopLanAccessEnabled: draftValue,
          desktopUiPassword: draftPassword,
          desktopMacMenuBarEnabled: draftMacMenuBarEnabled,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save desktop settings");
      }

      setSavedValue(draftValue);
      setSavedPassword(draftPassword);
      setSavedMacMenuBarEnabled(draftMacMenuBarEnabled);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error("Saved, but failed to restart app");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save desktop settings");
      setIsSaving(false);
    }
  }, [draftMacMenuBarEnabled, draftPassword, draftValue, isDirty]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <SettingsSection title={"Desktop Network Access"}>
      <div className="space-y-3">
        {(launchAtLoginSupported || isMacDesktop || minimizeToTraySupported || keepAwakeSupported) ? (
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
                label={"Minimize and close to the system tray"}
                info={"Keeps PiChamber running in the system tray when the main window is minimized or closed."}
                ariaLabel={"Minimize and close PiChamber to the system tray"}
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

        <SettingsStackedField
          settingsItem="sessions.desktop-ui-password"
          label={(
            <label htmlFor="desktop-ui-password">
              {"Desktop UI Password"}
            </label>
          )}
          info={"PiChamber asks after restart, then when the login session expires: after 12 hours, or 7 days with Trust this device. Leave empty to disable login."}
        >
          <Input
            id="desktop-ui-password"
            type={showPassword ? 'text' : 'password'}
            className="h-8 min-w-0 flex-1"
            value={draftPassword}
            onChange={(event) => handlePasswordChange(event.target.value)}
            placeholder={"No password required"}
            disabled={isLoading || isSaving}
            required={draftValue}
            aria-invalid={lanRequiresPassword}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setShowPassword((current: boolean) => !current)}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={(showPassword ? "Hide password" : "Show password")}
            aria-pressed={showPassword}
          >
            <Icon name={showPassword ? 'eye-off' : 'eye'} className="h-4 w-4" />
          </Button>
        </SettingsStackedField>

        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="sessions.desktop-lan-access"
            checked={draftValue}
            onChange={setDraftValue}
            disabled={isLoading || isSaving}
            label={"Let other devices on your local network open this app"}
            info={"Restarts the app so phones, tablets, and other computers on your Wi-Fi can open it."}
            description={(
              <>
                <span className="block text-[var(--status-warning)]/85">
                  {"Warning: while enabled, the app is reachable by anyone on the same local network."}
                </span>
                {lanRequiresPassword || lanBlockedByMissingPassword ? (
                  <span className="block text-[var(--status-warning)]/85">
                    {"LAN access requires a Desktop UI Password. Until one is set, the desktop app starts local-only."}
                  </span>
                ) : null}
              </>
            )}
            ariaLabel={"Allow LAN access to desktop sidecar"}
          />
        </div>

        {error ? (
          <div className="typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}

        {lanUrl ? (
          <div className="typography-micro text-muted-foreground/80">
            {isDirty && !savedValue
              ? "After restart, open from another device: "
              : "Open from another device: "}
            <span className="font-mono text-foreground">{lanUrl}</span>
          </div>
        ) : null}

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
      </div>
    </SettingsSection>
  );
};
