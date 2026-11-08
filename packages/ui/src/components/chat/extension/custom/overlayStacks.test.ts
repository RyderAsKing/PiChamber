import { describe, expect, test } from 'bun:test';

import type { PiExtensionSurfaceState } from '@/lib/pi/reducers/customSurfaceReducers';
import { NO_STACK_ANCHORS, groupPanels, isShownOverlay, nextStackAnchors, panelLabel, titleTabSpot } from './overlayStacks';

const panel = (surfaceId: string, row: number, col: number, extra: Partial<PiExtensionSurfaceState> = {}): PiExtensionSurfaceState => ({
  surfaceId,
  parentId: 'controller',
  title: '/overlay-focus',
  mode: 'overlay',
  capturing: false,
  hidden: false,
  focused: false,
  z: 1,
  frame: {
    version: 1,
    lines: ['╭──────╮', `│ ${surfaceId} visible │`],
    cells: [undefined, undefined],
    cursor: null,
    layout: { row, col, width: 34, height: 7 },
    visible: true,
    columns: 80,
    screenColumns: 150,
    rows: 40,
  },
  ...extra,
});

const ORDER = ['controller', 'Alpha', 'Beta', 'Gamma'];

describe('nextStackAnchors', () => {
  test('keeps a stack where it first appeared while its panels close one by one', () => {
    const alpha = panel('Alpha', 2, 4);
    const beta = panel('Beta', 5, 28);
    const gamma = panel('Gamma', 8, 52);
    let anchors = nextStackAnchors(NO_STACK_ANCHORS, groupPanels([alpha, beta, gamma], ORDER));
    expect(anchors.get('controller')).toEqual({ row: 2, col: 4 });

    // Escape closes Alpha, then Beta: the stack, then the last panel, stay put.
    for (const shown of [[beta, gamma], [gamma]]) {
      const next = nextStackAnchors(anchors, groupPanels(shown, ORDER));
      expect(next).toBe(anchors);
      anchors = next;
    }
    expect(anchors.get('controller')).toEqual({ row: 2, col: 4 });

    // Gone once no panel is shown, so a new stack picks its own spot.
    anchors = nextStackAnchors(anchors, groupPanels([], ORDER));
    expect(anchors.has('controller')).toBe(false);
  });

  test('gives a panel that never shared a stack no anchor, so it stays at its Pi position', () => {
    expect(nextStackAnchors(NO_STACK_ANCHORS, groupPanels([panel('Beta', 5, 28)], ORDER)).size).toBe(0);
  });
});

describe('groupPanels and panelLabel', () => {
  test('orders tabs as the panels opened and puts the focused panel in front', () => {
    const [group] = groupPanels(
      [panel('Gamma', 8, 52, { z: 4 }), panel('Alpha', 2, 4, { z: 5 }), panel('Beta', 5, 28, { z: 3, focused: true })],
      ORDER,
    );
    expect(group?.members.map((member) => member.surfaceId)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(group?.front.surfaceId).toBe('Beta');
  });

  test('names a tab from the first word of text, else by position', () => {
    expect(panelLabel(panel('Alpha', 0, 0), 0)).toBe('Alpha');
    const blank = panel('x', 0, 0);
    blank.frame = { ...blank.frame!, lines: ['╭──╮', '╰──╯'] };
    expect(panelLabel(blank, 2)).toBe('Panel 3');
  });
});

describe('isShownOverlay', () => {
  test('counts only overlays drawn on the pane right now', () => {
    const shown = panel('Alpha', 2, 4);
    expect(isShownOverlay(shown)).toBe(true);
    expect(isShownOverlay({ ...shown, hidden: true })).toBe(false);
    expect(isShownOverlay({ ...shown, mode: 'inline' })).toBe(false);
    expect(isShownOverlay({ ...shown, frame: { ...shown.frame!, visible: false } })).toBe(false);
    expect(isShownOverlay({ ...shown, frame: { ...shown.frame!, layout: null } })).toBe(false);
  });
});

describe('titleTabSpot', () => {
  test('puts the tab above, below at the top edge, or inside a box as tall as the screen', () => {
    expect(titleTabSpot({ top: 200, layoutHeight: 100, height: 100 }, 600, 16)).toBe('above');
    expect(titleTabSpot({ top: 0, layoutHeight: 100, height: 100 }, 600, 16)).toBe('below');
    expect(titleTabSpot({ top: 0, layoutHeight: 600, height: 600 }, 600, 16)).toBe('inside');
  });

  test('uses the clamped position: a tall box low on the screen is pushed up', () => {
    // Laid out at 300 px but 590 px tall on a 600 px screen: drawn at 10 px.
    expect(titleTabSpot({ top: 300, layoutHeight: 590, height: 590 }, 600, 16)).toBe('inside');
  });

  test('counts the drawn height of a scaled box', () => {
    expect(titleTabSpot({ top: 0, layoutHeight: 800, height: 400 }, 600, 16)).toBe('below');
  });
});
