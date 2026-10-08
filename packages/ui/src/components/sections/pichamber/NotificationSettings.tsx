import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isDesktopShell } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { Button } from '@/components/ui/button';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

export const NotificationSettings: React.FC = () => {
  const isDesktop = React.useMemo(() => isDesktopShell(), []);
  // The native Capacitor app runs in a WKWebView with no Web Notification API; it has its
  // own native (Local Notifications) permission. Treat it as a native runtime, not a
  // browser, so the toggle isn't gated on Notification.permission (which is stuck there).
  const isNativeApp = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    const capacitor = (window as typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return capacitor?.isNativePlatform?.() === true || window.location.protocol === 'capacitor:';
  }, []);
  const isBrowser = !isDesktop && !isNativeApp;
  const nativeNotificationsEnabled = useUIStore(state => state.nativeNotificationsEnabled);
  const setNativeNotificationsEnabled = useUIStore(state => state.setNativeNotificationsEnabled);
  const notificationMode = useUIStore(state => state.notificationMode);
  const setNotificationMode = useUIStore(state => state.setNotificationMode);
  const notifyOnCompletion = useUIStore(state => state.notifyOnCompletion);
  const setNotifyOnCompletion = useUIStore(state => state.setNotifyOnCompletion);
  const notifyOnError = useUIStore(state => state.notifyOnError);
  const setNotifyOnError = useUIStore(state => state.setNotifyOnError);
  const notifyOnInputNeeded = useUIStore(state => state.notifyOnInputNeeded);
  const setNotifyOnInputNeeded = useUIStore(state => state.setNotifyOnInputNeeded);

  const [notificationPermission, setNotificationPermission] = React.useState<NotificationPermission>('default');

  React.useEffect(() => {
    if (!isBrowser) {
      return;
    }

    if (typeof Notification !== 'undefined') {
      setNotificationPermission(Notification.permission);
    }
  }, [isBrowser]);

  const handleToggleChange = async (checked: boolean) => {
    if (isDesktop) {
      setNativeNotificationsEnabled(checked);
      return;
    }

    if (!isBrowser) {
      setNativeNotificationsEnabled(checked);
      return;
    }
    if (checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        const permission = await Notification.requestPermission();
        setNotificationPermission(permission);
        if (permission === 'granted') {
          setNativeNotificationsEnabled(true);
        } else {
          toast.error("Notification permission denied", {
            description: "Please enable notifications in your browser settings.",
          });
        }
      } catch (error) {
        console.error('Failed to request notification permission:', error);
        toast.error("Failed to request notification permission");
      }
    } else if (checked && notificationPermission === 'granted') {
      setNativeNotificationsEnabled(true);
    } else {
      setNativeNotificationsEnabled(false);
    }
  };

  const canShowNotifications = isDesktop || isNativeApp || (isBrowser && typeof Notification !== 'undefined' && Notification.permission === 'granted');

  const handleTestNotification = async () => {
    const apis = getRegisteredRuntimeAPIs();
    if (!apis?.notifications) {
      toast.error("Notifications API not available");
      return;
    }

    try {
      const success = await apis.notifications.notify({
        title: "Test notification",
        body: "Notifications are working.",
        tag: 'pichamber-test',
      });

      if (success) {
        toast.success("Test notification sent successfully");
      } else {
        toast.error("Failed to send test notification");
      }
    } catch (error) {
      console.error('Test notification failed:', error);
      toast.error("Failed to send test notification");
    }
  };

  return (
    <>
        <SettingsSection
          settingsItem="notifications.delivery"
          title={"Notification delivery"}
          divider={false}
        >
          <div className={SETTINGS_OPTION_STACK_CLASS}>
            <SettingsCheckboxRow
              checked={nativeNotificationsEnabled && canShowNotifications}
              onChange={(checked) => {
                void handleToggleChange(checked);
              }}
              label={"Enable notifications"}
              info={
                isBrowser
                  ? "Your browser may ask for permission the first time."
                  : undefined
              }
              ariaLabel={"Enable notifications"}
            />

            {/* The native Capacitor app never notifies while focused (hard rule) and uses
                generic, non-customizable text, so the "notify while focused" toggle and the
                test button are hidden there. */}
            {nativeNotificationsEnabled && canShowNotifications && !isNativeApp && (
              <>
                <SettingsCheckboxRow
                  checked={notificationMode === 'always'}
                  onChange={(checked) => setNotificationMode(checked ? 'always' : 'hidden-only')}
                  label={"Notify while app is focused"}
                  ariaLabel={"Notify while app is focused"}
                />

                <div className="py-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleTestNotification()}
                  >
                    {"Send test notification"}
                  </Button>
                </div>
              </>
            )}
          </div>

          {isBrowser && (
            <div className="mt-1">
              {notificationPermission === 'denied' && (
                <p className="typography-meta text-[var(--status-error)] mt-1">
                  {"Notification permission denied. Enable it in your browser settings."}
                </p>
              )}
              {notificationPermission === 'granted' && !nativeNotificationsEnabled && (
                <p className="typography-meta text-muted-foreground/70 mt-1">
                  {"Permission granted, but notifications are disabled."}
                </p>
              )}
            </div>
          )}
        </SettingsSection>

        {nativeNotificationsEnabled && canShowNotifications && (
          <>
            <SettingsSection
              settingsItem="notifications.events"
              title={"Notification events"}
            >
              <div className={SETTINGS_OPTION_STACK_CLASS}>
                <SettingsCheckboxRow
                  checked={notifyOnCompletion}
                  onChange={setNotifyOnCompletion}
                  label={"Work completed"}
                  ariaLabel={"Notify when work is completed"}
                />

                <SettingsCheckboxRow
                  checked={notifyOnError}
                  onChange={setNotifyOnError}
                  label={"Errors"}
                  ariaLabel={"Notify when work fails"}
                />

                <SettingsCheckboxRow
                  checked={notifyOnInputNeeded}
                  onChange={setNotifyOnInputNeeded}
                  label={"Input needed"}
                  ariaLabel={"Notify when an extension is waiting for your answer"}
                  info={"When an extension is waiting for your answer."}
                />
              </div>
            </SettingsSection>

          </>
        )}

    </>
  );
};
