import { describe, expect, test as it } from 'bun:test';

import { cellAt, wheelSteps } from './useSurfacePointer';

describe('cellAt', () => {
  const grid = { columns: 20, rows: 4, cellWidth: 8, lineHeight: 18 };
  const origin = { left: 100, top: 50 };

  it('maps a point to the cell under it', () => {
    expect(cellAt(grid, origin, 100, 50)).toEqual({ col: 0, row: 0 });
    expect(cellAt(grid, origin, 123.9, 85.9)).toEqual({ col: 2, row: 1 });
  });

  it('clamps points outside the surface, as a drag past the edge', () => {
    expect(cellAt(grid, origin, 40, 10)).toEqual({ col: 0, row: 0 });
    expect(cellAt(grid, origin, 900, 900)).toEqual({ col: 19, row: 3 });
  });
});

describe('wheelSteps', () => {
  it('turns pixel, line and page deltas into lines', () => {
    expect(wheelSteps({ deltaY: 36, deltaMode: 0 }, 0, 18, 10)).toEqual({ steps: 2, rest: 0 });
    expect(wheelSteps({ deltaY: -3, deltaMode: 1 }, 0, 18, 10)).toEqual({ steps: -3, rest: 0 });
    expect(wheelSteps({ deltaY: 1, deltaMode: 2 }, 0, 18, 4)).toEqual({ steps: 4, rest: 0 });
  });

  it('adds small trackpad deltas up to a step', () => {
    let state = wheelSteps({ deltaY: 6, deltaMode: 0 }, 0, 18, 10);
    expect(state.steps).toBe(0);
    state = wheelSteps({ deltaY: 6, deltaMode: 0 }, state.rest, 18, 10);
    expect(state.steps).toBe(0);
    state = wheelSteps({ deltaY: 6, deltaMode: 0 }, state.rest, 18, 10);
    expect(state.steps).toBe(1);
  });

  it('caps one event at five steps', () => {
    expect(wheelSteps({ deltaY: 2000, deltaMode: 0 }, 0, 18, 10).steps).toBe(5);
    expect(wheelSteps({ deltaY: -2000, deltaMode: 0 }, 0, 18, 10).steps).toBe(-5);
  });
});
