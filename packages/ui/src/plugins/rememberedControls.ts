import type { PiComposerControl } from '@/lib/pi/protocol';

/**
 * The composer controls a folder's Pi extensions last declared, kept in
 * localStorage per server and folder. A new-session draft draws them while
 * its draft session starts, then the runtime's own controls replace them.
 * They are only a picture of the last state: a click on one waits for the
 * runtime and runs there.
 */

const STORAGE_KEY = 'pichamber:remembered-composer-controls:v1';
/** Folders kept; the least recently seen go first. */
const MAX_FOLDERS = 40;
const MAX_CONTROLS = 16;

interface RememberedEntry {
  controls: PiComposerControl[];
  at: number;
}

type RememberedMap = Record<string, RememberedEntry>;

const folderKey = (runtimeKey: string, directory: string): string => `${runtimeKey}\n${directory}`;

const isString = (value: unknown, max: number): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= max
);

const optionalString = (value: unknown, max: number): boolean => value === undefined || isString(value, max);

/** A stored control is used only when it still has the shape the composer draws. */
export const isRememberedControl = (value: unknown): value is PiComposerControl => {
  if (!value || typeof value !== 'object') return false;
  const control = value as Record<string, unknown>;
  if (!isString(control.id, 64) || !isString(control.label, 80)) return false;
  if (!optionalString(control.description, 400) || !optionalString(control.icon, 64)) return false;
  if (control.kind === 'toggle') return typeof control.value === 'boolean' && isString(control.command, 200);
  if (control.kind === 'action') return isString(control.command, 200);
  if (control.kind !== 'cycle' || !Array.isArray(control.options)) return false;
  if (control.options.length < 2 || control.options.length > 12) return false;
  if (!control.options.every((option) => option && typeof option === 'object'
    && isString((option as Record<string, unknown>).value, 64)
    && isString((option as Record<string, unknown>).label, 80)
    && isString((option as Record<string, unknown>).command, 200))) return false;
  return optionalString(control.value, 64);
};

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

const readAll = (): RememberedMap => {
  const store = storage();
  if (!store) return {};
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: RememberedMap = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const { controls, at } = entry as Record<string, unknown>;
      if (!Array.isArray(controls) || typeof at !== 'number' || !Number.isFinite(at)) continue;
      result[key] = { controls: controls.filter(isRememberedControl).slice(0, MAX_CONTROLS), at };
    }
    return result;
  } catch {
    return {};
  }
};

const writeAll = (map: RememberedMap): void => {
  const store = storage();
  if (!store) return;
  const kept = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_FOLDERS);
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // A full or blocked storage only costs the picture on the next draft.
  }
};

/** What the folder's extensions last declared, or none when nothing is known. */
export const readRememberedControls = (runtimeKey: string, directory: string | null | undefined): PiComposerControl[] => {
  if (!directory) return [];
  return readAll()[folderKey(runtimeKey, directory)]?.controls ?? [];
};

/**
 * Remember what a folder's extensions declared. A draft session's set is
 * authoritative, empty included (an extension removed since). An open
 * session's set is remembered only when it has controls: an older session
 * may simply not have reported them yet.
 */
export const rememberControls = (
  runtimeKey: string,
  directory: string | null | undefined,
  controls: readonly PiComposerControl[],
  { authoritative }: { authoritative: boolean },
): void => {
  if (!directory) return;
  if (!authoritative && controls.length === 0) return;
  const map = readAll();
  const key = folderKey(runtimeKey, directory);
  const next = controls.filter(isRememberedControl).slice(0, MAX_CONTROLS);
  const previous = map[key]?.controls;
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
  map[key] = { controls: next, at: Date.now() };
  writeAll(map);
};
