import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './messages/en';
import { settingsDict } from './messages/en.settings';

describe('i18n dictionaries', () => {
  test('english dictionary exposes expected surface keys', () => {
    expect(enDict['chat.chatInput.placeholder.chatCompact']).toBeTruthy();
    expect(enDict['settings.pichamber.visual.section.localization']).toBeTruthy();
  });

  test('settings dictionary is merged into the main dictionary', () => {
    expect(settingsDict['settings.pichamber.visual.field.timeFormat']).toBeTruthy();
    expect(enDict['settings.pichamber.visual.field.timeFormat']).toBeTruthy();
  });
});
