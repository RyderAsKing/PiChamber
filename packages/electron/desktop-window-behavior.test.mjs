import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTrayWindowBehaviorSupported,
  readCloseToTrayEnabled,
  readMinimizeToTrayEnabled,
} from './desktop-window-behavior.mjs';

test('tray window behavior is limited to Windows and Linux', () => {
  assert.equal(isTrayWindowBehaviorSupported('win32'), true);
  assert.equal(isTrayWindowBehaviorSupported('linux'), true);
  assert.equal(isTrayWindowBehaviorSupported('darwin'), false);
});

test('new installs minimize normally and close to the tray', () => {
  assert.equal(readMinimizeToTrayEnabled({}), false);
  assert.equal(readCloseToTrayEnabled({}), true);
});

test('an explicit close preference is independent from minimize', () => {
  const settings = {
    desktopMinimizeToTrayEnabled: true,
    desktopCloseToTrayEnabled: false,
  };

  assert.equal(readMinimizeToTrayEnabled(settings), true);
  assert.equal(readCloseToTrayEnabled(settings), false);
});

test('the old combined preference remains the close preference until changed', () => {
  assert.equal(readCloseToTrayEnabled({ desktopMinimizeToTrayEnabled: true }), true);
  assert.equal(readCloseToTrayEnabled({ desktopMinimizeToTrayEnabled: false }), false);
});
