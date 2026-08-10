/**
 * Lock the `<script>` PWA-storage literals in `packages/web/index.html`
 * to the canonical key constants from `@pichamber/ui/src/lib/pwaKeys.ts`.
 *
 * `index.html` runs before the React bundle and cannot import TypeScript,
 * so the only thing keeping the two surfaces in sync is this test.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  MOBILE_KEYBOARD_MODE_STORAGE_KEY,
  PWA_NAME_STORAGE_KEY,
  PWA_ORIENTATION_STORAGE_KEY,
  PWA_RECENT_SESSIONS_STORAGE_KEY,
} from '../../../ui/src/lib/pwaKeys.ts';

const EXPECTED_KEYS = {
  pwaName: 'pichamber.pwaName',
  pwaOrientation: 'pichamber.pwaOrientation',
  mobileKeyboardMode: 'pichamber.mobileKeyboardMode',
  pwaRecentSessions: 'pichamber.pwaRecentSessions',
};

const resolveIndexHtml = () => {
  return path.resolve(process.cwd(), 'index.html');
};

describe('PWA storage key contract', () => {
  it('exports the four pichamber.* key constants from pwaKeys.ts', () => {
    expect(PWA_NAME_STORAGE_KEY).toBe(EXPECTED_KEYS.pwaName);
    expect(PWA_ORIENTATION_STORAGE_KEY).toBe(EXPECTED_KEYS.pwaOrientation);
    expect(MOBILE_KEYBOARD_MODE_STORAGE_KEY).toBe(EXPECTED_KEYS.mobileKeyboardMode);
    expect(PWA_RECENT_SESSIONS_STORAGE_KEY).toBe(EXPECTED_KEYS.pwaRecentSessions);
  });

  it('index.html references exactly the four canonical keys', () => {
    const html = fs.readFileSync(resolveIndexHtml(), 'utf8');
    const substringCount = (needle) => {
      let from = 0;
      let count = 0;
      while (from < html.length) {
        const index = html.indexOf(needle, from);
        if (index < 0) break;
        count += 1;
        from = index + needle.length;
      }
      return count;
    };
    expect(substringCount(EXPECTED_KEYS.pwaName)).toBeGreaterThanOrEqual(1);
    expect(substringCount(EXPECTED_KEYS.pwaOrientation)).toBeGreaterThanOrEqual(1);
    expect(substringCount(EXPECTED_KEYS.mobileKeyboardMode)).toBeGreaterThanOrEqual(1);
    expect(substringCount(EXPECTED_KEYS.pwaRecentSessions)).toBeGreaterThanOrEqual(1);

    expect(/openchamber\.pwaName\b/.test(html)).toBe(false);
    expect(/openchamber\.pwaOrientation\b/.test(html)).toBe(false);
    expect(/openchamber\.mobileKeyboardMode\b/.test(html)).toBe(false);
    expect(/openchamber\.pwaRecentSessions\b/.test(html)).toBe(false);
  });
});
