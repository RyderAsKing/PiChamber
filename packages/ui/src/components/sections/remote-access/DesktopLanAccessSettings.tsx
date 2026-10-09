import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import type { DesktopLanAccessState } from './useDesktopLanAccessState';
import {
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
  SettingsStackedField,
  SETTINGS_ICON_BUTTON_CLASS,
} from '@/components/sections/shared/SettingsSection';

/** LAN toggle half: renders in Ways to connect. */
export const DesktopLanToggleFields: React.FC<{ lan: DesktopLanAccessState }> = ({ lan }) => (
  <>
    <div className={SETTINGS_OPTION_STACK_CLASS}>
      <SettingsCheckboxRow
        settingsItem="sessions.desktop-lan-access"
        checked={lan.draftLanEnabled}
        onChange={lan.setDraftLanEnabled}
        disabled={lan.isLoading || lan.isSaving}
        label={'Let other devices on your local network open this app'}
        info={'Restarts the app so phones, tablets, and other computers on your Wi-Fi can open it. On Windows, allow PiChamber through the firewall if a phone still cannot connect.'}
        description={(
          <>
            <span className="block text-[var(--status-warning)]/85">
              {'Warning: while enabled, the app is reachable by anyone on the same local network.'}
            </span>
            {lan.lanRequiresPassword || lan.lanBlockedByMissingPassword ? (
              <span className="block text-[var(--status-warning)]/85">
                {'LAN access requires a Desktop UI Password. Until one is set, the desktop app starts local-only.'}
              </span>
            ) : null}
          </>
        )}
        ariaLabel={'Allow LAN access to desktop sidecar'}
      />
    </div>

    {lan.error ? (
      <div className="typography-micro text-[var(--status-error)]">{lan.error}</div>
    ) : null}

    {lan.lanUrl ? (
      <div className="typography-micro text-muted-foreground/80">
        {lan.isDirty && !lan.draftLanEnabled
          ? 'After restart, open from another device: '
          : 'Open from another device: '}
        <span className="font-mono text-foreground">{lan.lanUrl}</span>
      </div>
    ) : null}

    <div className="flex justify-start py-1.5">
      <Button
        type="button"
        size="xs"
        onClick={lan.saveAndRestart}
        disabled={lan.saveDisabled}
        className="shrink-0 !font-normal"
      >
        {lan.isSaving ? 'Saving...' : 'Save + Restart'}
      </Button>
    </div>
  </>
);

/** Password half: renders in Security. The input keeps the stable
 * `desktop-ui-password` id so the Tailscale auth-required callout can
 * focus/scroll to it. */
export const DesktopPasswordFields: React.FC<{ lan: DesktopLanAccessState }> = ({ lan }) => (
  <>
    <SettingsStackedField
      settingsItem="sessions.desktop-ui-password"
      label={(
        <label htmlFor="desktop-ui-password">
          {'Desktop UI Password'}
        </label>
      )}
      info={'PiChamber asks after restart, then when the login session expires: after 12 hours, or 7 days with Trust this device. Leave empty to disable login.'}
    >
      <Input
        id="desktop-ui-password"
        type={lan.showPassword ? 'text' : 'password'}
        className="h-8 min-w-0 flex-1"
        value={lan.draftPassword}
        onChange={(event) => lan.handlePasswordChange(event.target.value)}
        placeholder={'No password required'}
        disabled={lan.isLoading || lan.isSaving}
        required={lan.draftLanEnabled}
        aria-invalid={lan.lanRequiresPassword}
      />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => lan.setShowPassword((current: boolean) => !current)}
        className={SETTINGS_ICON_BUTTON_CLASS}
        aria-label={(lan.showPassword ? 'Hide password' : 'Show password')}
        aria-pressed={lan.showPassword}
      >
        <Icon name={lan.showPassword ? 'eye-off' : 'eye'} className="h-4 w-4" />
      </Button>
    </SettingsStackedField>

    {lan.error ? (
      <div className="typography-micro text-[var(--status-error)]">{lan.error}</div>
    ) : null}

    <div className="flex justify-start py-1.5">
      <Button
        type="button"
        size="xs"
        onClick={lan.saveAndRestart}
        disabled={lan.saveDisabled}
        className="shrink-0 !font-normal"
      >
        {lan.isSaving ? 'Saving...' : 'Save + Restart'}
      </Button>
    </div>
  </>
);
