export type SettingsSaveState = 'idle' | 'saving' | 'error';

let _settingsSaveState: SettingsSaveState = 'idle';
const _settingsSaveStateListeners = new Set<() => void>();
let _settingsSaveStateResetTimer: ReturnType<typeof setTimeout> | null = null;

export const getSettingsSaveState = (): SettingsSaveState => _settingsSaveState;

export const subscribeToSettingsSaveState = (
  listener: () => void
): (() => void) => {
  _settingsSaveStateListeners.add(listener);
  return () => _settingsSaveStateListeners.delete(listener);
};

export const dispatchSettingsSaveState = (
  state: 'saving' | 'saved' | 'error'
): void => {
  if (_settingsSaveStateResetTimer) {
    clearTimeout(_settingsSaveStateResetTimer);
    _settingsSaveStateResetTimer = null;
  }

  const nextState: SettingsSaveState = state === 'saved' ? 'idle' : state;
  if (nextState !== _settingsSaveState) {
    _settingsSaveState = nextState;
    _settingsSaveStateListeners.forEach((listener) => listener());
  }

  if (nextState === 'error') {
    _settingsSaveStateResetTimer = setTimeout(
      () => dispatchSettingsSaveState('saved'),
      6000
    );
  }

  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<'saving' | 'saved' | 'error'>(
      'pichamber:settings-save-state',
      { detail: state }
    )
  );
};

/**
 * Drive the shared settings save indicator from pages that persist through
 * their own APIs instead of updateDesktopSettings. 'error' resets to idle.
 */
export const reportSettingsSaveState = (
  state: 'saving' | 'saved' | 'error'
): void => {
  dispatchSettingsSaveState(state);
};
