import { stripAnsi } from '@/lib/pi/ansi';
import type { PiExtensionSurfaceState } from '@/lib/pi/reducers/customSurfaceReducers';

/**
 * Tab stacks for overlay panels (plan: docs/plans/pi-extension-custom.md,
 * 4.2): which panels share a stack, what each tab is called, and where a
 * stack sits. Pure, so the rules are testable without a DOM.
 */

/** An overlay drawn on the pane screen right now. */
export const isShownOverlay = (surface: PiExtensionSurfaceState): boolean => (
  surface.mode === 'overlay' && !surface.hidden && surface.frame?.visible !== false && Boolean(surface.frame?.layout)
);

const BOX_DRAWING = /[\u2500-\u259f]/g;

/**
 * A tab name for a panel. Pi overlays carry no label, so this is the first
 * word of the panel's first line of text (Alpha in "│ Alpha visible │").
 */
export const panelLabel = (surface: PiExtensionSurfaceState, index: number): string => {
  for (const line of surface.frame?.lines ?? []) {
    const word = stripAnsi(line).replace(BOX_DRAWING, ' ').trim().split(/\s+/)[0] ?? '';
    if (/[\p{L}\p{N}]/u.test(word)) return word.length > 16 ? `${word.slice(0, 15)}…` : word;
  }
  return `Panel ${index + 1}`;
};

/** Where a stack sits, in cells on the pane screen. */
export interface StackAnchor {
  row: number;
  col: number;
}

export interface OverlayStackGroup {
  parentId: string;
  members: PiExtensionSurfaceState[];
  front: PiExtensionSurfaceState;
}

/**
 * Groups shown panels by the overlay that opened them. Tabs follow the
 * order the panels opened in. The front panel is the focused one, else the
 * capturing or plain panel Pi draws on top.
 */
export const groupPanels = (overlays: PiExtensionSurfaceState[], order: string[]): OverlayStackGroup[] => {
  const byParent = new Map<string, PiExtensionSurfaceState[]>();
  for (const surface of overlays) {
    if (!surface.parentId) continue;
    const members = byParent.get(surface.parentId) ?? [];
    members.push(surface);
    byParent.set(surface.parentId, members);
  }
  const position = new Map(order.map((surfaceId, index) => [surfaceId, index]));
  const groups: OverlayStackGroup[] = [];
  for (const [parentId, members] of byParent) {
    const byZ = [...members].sort((a, b) => b.z - a.z);
    const front = members.find((member) => member.focused) ?? byZ.find((member) => member.capturing) ?? byZ[0]!;
    members.sort((a, b) => (position.get(a.surfaceId) ?? 0) - (position.get(b.surfaceId) ?? 0));
    groups.push({ parentId, members, front });
  }
  return groups;
};

export const NO_STACK_ANCHORS: ReadonlyMap<string, StackAnchor> = new Map();

/**
 * Where each stack sits: the Pi position of its first panel when two of its
 * panels first showed together. Kept while any of its panels is shown, so
 * closing the panel that placed the stack does not move it, and dropped once
 * none is. Returns `anchors` itself when nothing changed.
 */
export const nextStackAnchors = (
  anchors: ReadonlyMap<string, StackAnchor>,
  groups: OverlayStackGroup[],
): ReadonlyMap<string, StackAnchor> => {
  let next: Map<string, StackAnchor> | null = null;
  const live = new Set(groups.map((group) => group.parentId));
  for (const group of groups) {
    if (group.members.length < 2 || anchors.has(group.parentId)) continue;
    const layout = group.members[0]?.frame?.layout;
    next ??= new Map(anchors);
    next.set(group.parentId, { row: layout?.row ?? 0, col: layout?.col ?? 0 });
  }
  for (const parentId of anchors.keys()) {
    if (live.has(parentId)) continue;
    next ??= new Map(anchors);
    next.delete(parentId);
  }
  return next ?? anchors;
};

/**
 * Where an overlay's title tab goes: above the box, below it when the box
 * sits at the top of the screen, or inside its top corner when the box is
 * as tall as the screen and neither edge has room. `top` is where the box
 * is placed (clamped to the screen as `placementStyle` does), `height` its
 * drawn height, both in px; `space` is what the tab needs.
 */
export const titleTabSpot = (
  box: { top: number; layoutHeight: number; height: number },
  screenHeight: number,
  space: number,
): 'above' | 'below' | 'inside' => {
  if (!(screenHeight > 0)) return box.top < space ? 'below' : 'above';
  const top = Math.max(0, Math.min(box.top, screenHeight - box.layoutHeight));
  if (top >= space) return 'above';
  if (top + box.height + space <= screenHeight) return 'below';
  return 'inside';
};
