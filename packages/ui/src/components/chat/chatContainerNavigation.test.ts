import { describe, expect, test } from 'bun:test';

import { composerBarClassName } from './chatContainerNavigation';

describe('composerBarClassName', () => {
  test('keeps the composer above the timeline', () => {
    expect(composerBarClassName(false).split(' ')).toContain('z-10');
  });

  test('drops its stacking order while a custom() overlay dims the pane, so the prompt dock can rise above the overlay', () => {
    const classes = composerBarClassName(false, true).split(' ');
    expect(classes).toContain('relative');
    expect(classes).not.toContain('z-10');
  });
});
