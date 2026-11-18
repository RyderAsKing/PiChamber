import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FOLLOW_UP_BEHAVIOR_OPTIONS,
  collapsedFamilies,
  familyOf,
  themeFamilies,
  type ThemeFamily,
  normalizePwaOrientation,
} from './visualSettingsConstants';
import type { Theme } from '@/types/theme';
import {
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  isFollowUpBehavior,
  normalizeFollowUpBehavior,
} from '@/stores/messageQueueStore';
import { getSettingsPageMeta } from '@/lib/settings/metadata';
import { buildSettingsSearchResults } from '@/lib/settings/search';

describe('visualSettingsConstants helpers', () => {
  describe('normalizePwaOrientation', () => {
    test('accepts valid orientations', () => {
      expect(normalizePwaOrientation('portrait')).toBe('portrait');
      expect(normalizePwaOrientation('landscape')).toBe('landscape');
      expect(normalizePwaOrientation('system')).toBe('system');
    });

    test('defaults invalid values to system', () => {
      expect(normalizePwaOrientation('unknown')).toBe('system');
      expect(normalizePwaOrientation(null)).toBe('system');
      expect(normalizePwaOrientation(123)).toBe('system');
    });
  });
});

describe('follow-up behavior wording', () => {
  test('keeps protocol values while using user-facing Follow-up and Steering labels', () => {
    const byId = new Map(FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => [option.id, option.label]));
    expect(byId.get('queue')).toBe('Follow-up');
    expect(byId.get('steer')).toBe('Steering');
  });

  test('preserves the persisted queue default and steering preference', () => {
    expect(DEFAULT_FOLLOW_UP_BEHAVIOR).toBe('queue');
    expect(isFollowUpBehavior('queue')).toBe(true);
    expect(isFollowUpBehavior('steer')).toBe(true);
    expect(normalizeFollowUpBehavior('queue', null)).toBe('queue');
    expect(normalizeFollowUpBehavior('steer', null)).toBe('steer');
  });

  test('chat-message queue surfaces use Follow-up wording with a Steering send action', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const chips = readFileSync(join(here, '../../../chat/QueuedMessageChips.tsx'), 'utf8');
    expect(chips).toContain('Follow-up messages');
    expect(chips).not.toContain('Queued messages');
    expect(chips).toContain('Remove follow-up');
    expect(chips).not.toContain('Remove from queue');
    expect(chips).toContain('Steer');
    expect(chips).toContain('Send now with steering');
    expect(chips).toContain('steering message waiting');
    expect(chips).toContain('steering messages waiting');
    expect(chips).toContain('follow-up message waiting');
    expect(chips).toContain('follow-up messages waiting');

    const actions = readFileSync(
      join(here, '../../../chat/composer/ui/ComposerActionButtons.tsx'),
      'utf8',
    );
    expect(actions).toContain('Add follow-up');
    expect(actions).not.toContain('Queue message');

    const section = readFileSync(join(here, 'ChatBehaviorSection.tsx'), 'utf8');
    expect(section).toContain('Follow-up waits until the agent finishes');
    expect(section).toContain('next supported tool or turn boundary');
    expect(section).toContain('stay on this device');
  });

  test('settings search explains Follow-up versus Steering without promising cross-device delivery', () => {
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
    const getPageTitle = (slug: string) => getSettingsPageMeta(slug)?.title ?? slug;

    for (const query of ['follow-up', 'steering', 'queue']) {
      const results = buildSettingsSearchResults({ query, runtimeCtx, getPageTitle });
      expect(results.some((result) => result.id === 'chat.follow-up-behavior')).toBe(true);
    }

    const [result] = buildSettingsSearchResults({
      query: 'follow-up behavior',
      runtimeCtx,
      getPageTitle,
    }).filter((entry) => entry.id === 'chat.follow-up-behavior');
    expect(result).toBeDefined();
    expect(result?.description ?? '').toContain('waits until the agent finishes');
    expect(result?.description ?? '').toContain('tool or turn boundary');
    expect(result?.description ?? '').toContain('stay on this device');
  });
});

describe('themeFamilies', () => {
  const theme = (id: string, name: string, variant: 'light' | 'dark') =>
    ({ metadata: { id, name, variant } }) as unknown as Theme;
  const summary = (families: ThemeFamily[]) =>
    families.map((family) => [family.name, family.light?.metadata.id ?? null, family.dark?.metadata.id ?? null]);

  test('pairs light and dark themes of the same name, in first-seen order', () => {
    const families = themeFamilies([
      theme('pichamber-light', 'PiChamber', 'light'),
      theme('pichamber-dark', 'PiChamber', 'dark'),
      theme('flexoki-dark', 'Flexoki', 'dark'),
      theme('flexoki-light', 'Flexoki', 'light'),
    ]);
    expect(summary(families)).toEqual([
      ['PiChamber', 'pichamber-light', 'pichamber-dark'],
      ['Flexoki', 'flexoki-light', 'flexoki-dark'],
    ]);
  });

  test('pairs names that end in their variant (Vitesse Dark and Vitesse Light)', () => {
    const families = themeFamilies([
      theme('vitesse-dark-dark', 'Vitesse Dark', 'dark'),
      theme('vitesse-light-light', 'Vitesse Light', 'light'),
      theme('onedarkpro-dark', 'One Dark Pro', 'dark'),
    ]);
    expect(summary(families)).toEqual([
      ['Vitesse', 'vitesse-light-light', 'vitesse-dark-dark'],
      ['One Dark Pro', null, 'onedarkpro-dark'],
    ]);
  });

  test('keeps a second theme of the same name and variant as its own family', () => {
    const families = themeFamilies([theme('a', 'Ocean', 'dark'), theme('b', 'Ocean', 'dark')]);
    expect(summary(families)).toEqual([
      ['Ocean', null, 'a'],
      ['Ocean', null, 'b'],
    ]);
    expect(new Set(families.map((family) => family.key)).size).toBe(2);
    expect(familyOf(families, 'b')).toBe(families[1]);
  });
});

describe('collapsedFamilies', () => {
  const families = Array.from({ length: 8 }, (_, i) => ({ key: `f${i}`, name: `F${i}` }) as ThemeFamily);
  const keys = (list: ThemeFamily[]) => list.map((family) => family.key);

  test('shows the first five when the current family is among them', () => {
    expect(keys(collapsedFamilies(families, 'f2'))).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
  });

  test('swaps the current family in for the last one when it is further down', () => {
    expect(keys(collapsedFamilies(families, 'f7'))).toEqual(['f0', 'f1', 'f2', 'f3', 'f7']);
  });

  test('an unknown current family leaves the first five', () => {
    expect(keys(collapsedFamilies(families, undefined))).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(keys(collapsedFamilies(families.slice(0, 3), 'f7'))).toEqual(['f0', 'f1', 'f2']);
  });
});
