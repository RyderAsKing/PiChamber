import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FOLLOW_UP_BEHAVIOR_OPTIONS,
  normalizePwaOrientation,
} from './visualSettingsConstants';
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
    expect(chips).toContain('Send now with Steering');
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
