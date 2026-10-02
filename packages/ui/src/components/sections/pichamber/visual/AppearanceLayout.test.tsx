import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsDisclosure } from '@/components/sections/shared/SettingsSection';
import { LocalizationSection } from './LocalizationSection';
import { AppInstallSection } from './AppInstallSection';

describe('Appearance Layout and Primitives', () => {
  test('SettingsDisclosure renders a details element without open attribute, with summary label and children present', () => {
    const markup = renderToStaticMarkup(
      <SettingsDisclosure label="Show legacy options">
        <div data-testid="legacy-content">Legacy content</div>
      </SettingsDisclosure>,
    );

    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open');
    expect(markup).not.toContain('open=""');
    expect(markup).toContain('<summary');
    expect(markup).toContain('Show legacy options');
    expect(markup).toContain('data-testid="legacy-content"');
    expect(markup).toContain('Legacy content');
  });

  test('LocalizationSection renders two-column layout without old stack wrapper', () => {
    const markup = renderToStaticMarkup(
      <LocalizationSection
        shouldShowTimeFormat={true}
        shouldShowWeekStart={true}
        timeFormatPreference="auto"
        selectedTimeFormatLabel="Auto"
        onTimeFormatPreferenceChange={() => undefined}
        weekStartPreference="auto"
        selectedWeekStartLabel="Auto"
        onWeekStartPreferenceChange={() => undefined}
      />,
    );

    expect(markup).toContain('data-settings-item="appearance.time-format"');
    expect(markup).toContain('data-settings-item="appearance.week-start"');
    expect(markup).toContain('@md:grid-cols-2');
    expect(markup).not.toContain('space-y-3.5');
  });

  test('AppInstallSection renders all three data-settings-item anchors when all are shown', () => {
    const markup = renderToStaticMarkup(
      <AppInstallSection
        showPwaInstallNameSetting={true}
        pwaInstallName="PiChamber"
        setPwaInstallName={() => undefined}
        onApplyPwaInstallName={() => undefined}
        showPwaOrientationSetting={true}
        pwaOrientation="system"
        selectedPwaOrientationLabel="System default"
        onApplyPwaOrientation={() => undefined}
        showMobileKeyboardModeSetting={true}
        mobileKeyboardMode="native"
        selectedMobileKeyboardModeLabel="Native"
        onSetMobileKeyboardMode={() => undefined}
      />,
    );

    expect(markup).toContain('data-settings-item="appearance.pwa-install-name"');
    expect(markup).toContain('data-settings-item="appearance.pwa-orientation"');
    expect(markup).toContain('data-settings-item="appearance.mobile-keyboard-mode"');
  });
});
