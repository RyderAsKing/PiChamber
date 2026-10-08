import { describe, expect, test } from 'bun:test';

import {
  getSettingsPageMeta,
  type SettingsRuntimeContext,
} from '@/lib/settings/metadata';
import { buildSettingsSearchResults } from '@/lib/settings/search';
import {
  buildRuntimeContext,
  isPageAvailable,
} from '@/components/views/settings/settingsViewHelpers';

const desktopShell: SettingsRuntimeContext = {
  isWeb: false,
  isDesktop: true,
  isMobile: false,
};

const capacitor: SettingsRuntimeContext = {
  isWeb: false,
  isDesktop: false,
  isMobile: true,
  isCapacitor: true,
};

const hostedMobileWeb: SettingsRuntimeContext = {
  isWeb: true,
  isDesktop: false,
  isMobile: true,
};

const plainWeb: SettingsRuntimeContext = {
  isWeb: true,
  isDesktop: false,
  isMobile: false,
};

const getPageTitle = (slug: string) => getSettingsPageMeta(slug)?.title ?? slug;

describe('servers settings availability per runtime', () => {
  test('desktop shell yes, Capacitor yes, hosted mobile web no, plain web no', () => {
    const meta = getSettingsPageMeta('servers');
    expect(meta).not.toBeNull();
    expect(isPageAvailable(meta!, desktopShell)).toBe(true);
    expect(isPageAvailable(meta!, capacitor)).toBe(true);
    expect(isPageAvailable(meta!, hostedMobileWeb)).toBe(false);
    expect(isPageAvailable(meta!, plainWeb)).toBe(false);
  });

  test('a missing capacitor flag never grants mobile access', () => {
    const meta = getSettingsPageMeta('servers');
    expect(
      isPageAvailable(meta!, { isWeb: true, isDesktop: false, isMobile: true }),
    ).toBe(false);
  });

  test('buildRuntimeContext carries the capacitor flag', () => {
    expect(buildRuntimeContext(false, true, true)).toMatchObject({
      isMobile: true,
      isCapacitor: true,
    });
    expect(buildRuntimeContext(false, true).isCapacitor).toBe(false);
    expect(buildRuntimeContext(true, false).isCapacitor).toBe(false);
  });

  test('servers search targets follow page availability', () => {
    const searchResultsFor = (runtimeCtx: SettingsRuntimeContext) =>
      buildSettingsSearchResults({
        query: 'server',
        runtimeCtx: {
          ...runtimeCtx,
          isDesktopLocalOrigin: false,
          isMac: false,
          isWindows: false,
          isLinux: false,
          isWindowsArm64: false,
        },
        getPageTitle,
      });
    const hasServersRow = (runtimeCtx: SettingsRuntimeContext) =>
      searchResultsFor(runtimeCtx).some((result) => result.page === 'servers');

    expect(hasServersRow(desktopShell)).toBe(true);
    expect(hasServersRow(capacitor)).toBe(true);
    expect(hasServersRow(hostedMobileWeb)).toBe(false);
    expect(hasServersRow(plainWeb)).toBe(false);
  });
});
