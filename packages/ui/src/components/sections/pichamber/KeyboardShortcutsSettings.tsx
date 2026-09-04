import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SettingsSection,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  formatShortcutForDisplay,
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  isRiskyBrowserShortcut,
  keyToShortcutToken,
  normalizeCombo,
  UNASSIGNED_SHORTCUT,
  type ShortcutCombo,
} from '@/lib/shortcuts';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);

const keyboardEventToCombo = (event: React.KeyboardEvent<HTMLInputElement>): ShortcutCombo | null => {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) {
    return null;
  }

  const parts: string[] = [];

  if (event.metaKey || event.ctrlKey) {
    parts.push('mod');
  }
  if (event.shiftKey) {
    parts.push('shift');
  }
  if (event.altKey) {
    parts.push('alt');
  }

  const keyToken = keyToShortcutToken(event.key);
  if (!keyToken) {
    return null;
  }

  parts.push(keyToken);
  return normalizeCombo(parts.join('+'));
};

// Prefix capture for chord-style shortcuts (e.g. "switch context panel
// surface"): a bare modifier press is accepted so the prefix can be just the
// primary modifier (default) or a modifier + key chord like `mod+p`.
const keyboardEventToPrefixCombo = (event: React.KeyboardEvent<HTMLInputElement>): ShortcutCombo | null => {
  const parts: string[] = [];

  if (event.metaKey || event.ctrlKey) {
    parts.push('mod');
  }
  if (event.shiftKey) {
    parts.push('shift');
  }
  if (event.altKey) {
    parts.push('alt');
  }

  if (MODIFIER_KEYS.has(event.key.toLowerCase())) {
    return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
  }

  const keyToken = keyToShortcutToken(event.key);
  if (!keyToken) {
    return null;
  }

  parts.push(keyToken);
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
};


const SHORTCUT_ACTION_LABELS: Record<string, string> = {
  "add_selection_to_chat": "Add selection to chat",
  "cycle_agent": "Cycle agent",
  "cycle_draft_folder": "Cycle draft folder",
  "cycle_favorite_model_backward": "Cycle favorite model backward",
  "cycle_favorite_model_forward": "Cycle favorite model forward",
  "cycle_session_folder": "Cycle session folder",
  "cycle_theme": "Cycle theme",
  "focus_input": "Focus input",
  "new_chat": "New session",
  "new_mini_chat": "New Mini Chat window",
  "open_command_palette": "Open command palette",
  "open_help": "Open keyboard shortcuts",
  "open_model_selector": "Open model selector",
  "open_right_sidebar": "Open right sidebar",
  "open_settings": "Open settings",
  "open_timeline_dialog": "Open conversation timeline",
  "switch_context_surface": "Switch context panel surface",
  "toggle_services_menu": "Toggle services menu",
  "toggle_sidebar": "Toggle sidebar",
  "toggle_terminal": "Toggle terminal dock",
};
export const KeyboardShortcutsSettings: React.FC = () => {
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setShortcutOverride = useUIStore((state) => state.setShortcutOverride);
  const clearShortcutOverride = useUIStore((state) => state.clearShortcutOverride);
  const resetAllShortcutOverrides = useUIStore((state) => state.resetAllShortcutOverrides);

  const actions = React.useMemo(() => {
    return getCustomizableShortcutActions();
  }, []);
  const actionLabel = React.useCallback((id: string, fallbackLabel: string): string => {
    return SHORTCUT_ACTION_LABELS[id] ?? fallbackLabel;
  }, []);

  const [capturingActionId, setCapturingActionId] = React.useState<string | null>(null);
  const [draftByAction, setDraftByAction] = React.useState<Record<string, ShortcutCombo>>({});
  const [errorText, setErrorText] = React.useState<string>('');
  const [warningText, setWarningText] = React.useState<string>('');
  const [pendingOverwrite, setPendingOverwrite] = React.useState<{
    actionId: string;
    combo: ShortcutCombo;
    conflictActionId: string;
  } | null>(null);

  const persistShortcutOverrides = React.useCallback((nextOverrides: Record<string, ShortcutCombo>) => {
    void updateDesktopSettings({ shortcutOverrides: nextOverrides });
  }, []);

  const findConflict = React.useCallback((actionId: string, combo: ShortcutCombo): string | null => {
    const normalized = normalizeCombo(combo);
    for (const action of actions) {
      if (action.id === actionId) {
        continue;
      }
      const existing = getEffectiveShortcutCombo(action.id, shortcutOverrides);
      if (normalizeCombo(existing) === normalized) {
        return action.id;
      }
    }
    return null;
  }, [actions, shortcutOverrides]);

  const saveCombo = React.useCallback((actionId: string, combo: ShortcutCombo) => {
    const normalized = normalizeCombo(combo);
    const conflictActionId = findConflict(actionId, normalized);
    if (conflictActionId) {
      setPendingOverwrite({ actionId, combo: normalized, conflictActionId });
      setErrorText('');
      return;
    }

    const nextOverrides = { ...shortcutOverrides, [actionId]: normalized };
    setShortcutOverride(actionId, normalized);
    persistShortcutOverrides(nextOverrides);
    setPendingOverwrite(null);
    setErrorText('');
    setWarningText(isRiskyBrowserShortcut(normalized) ? "This shortcut can conflict with browser defaults. It is still saved." : '');
    setDraftByAction((current) => {
      const rest = { ...current };
      delete rest[actionId];
      return rest;
    });
  }, [findConflict, persistShortcutOverrides, setShortcutOverride, shortcutOverrides]);

  const confirmOverwrite = React.useCallback(() => {
    if (!pendingOverwrite) {
      return;
    }

    const nextOverrides = {
      ...shortcutOverrides,
      [pendingOverwrite.conflictActionId]: UNASSIGNED_SHORTCUT,
      [pendingOverwrite.actionId]: pendingOverwrite.combo,
    };
    setShortcutOverride(pendingOverwrite.conflictActionId, UNASSIGNED_SHORTCUT);
    setShortcutOverride(pendingOverwrite.actionId, pendingOverwrite.combo);
    persistShortcutOverrides(nextOverrides);
    setPendingOverwrite(null);
    setErrorText('');
    setWarningText(isRiskyBrowserShortcut(pendingOverwrite.combo) ? "This shortcut can conflict with browser defaults. It is still saved." : '');
    setDraftByAction((current) => {
      const rest = { ...current };
      delete rest[pendingOverwrite.actionId];
      return rest;
    });
  }, [pendingOverwrite, persistShortcutOverrides, setShortcutOverride, shortcutOverrides]);

  const resetOne = React.useCallback((actionId: string) => {
    const nextOverrides = { ...shortcutOverrides };
    delete nextOverrides[actionId];
    clearShortcutOverride(actionId);
    persistShortcutOverrides(nextOverrides);
    setDraftByAction((current) => {
      const rest = { ...current };
      delete rest[actionId];
      return rest;
    });
    setPendingOverwrite(null);
    setErrorText('');
    setWarningText('');
  }, [clearShortcutOverride, persistShortcutOverrides, shortcutOverrides]);

  return (
    <SettingsSection
      settingsItem="shortcuts.keyboard-shortcuts"
      title={"Keyboard Shortcuts"}
      divider={false}
      info={"Capture a new key combo, save it, and bindings will update immediately."}
      headerAction={(
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => {
            resetAllShortcutOverrides();
            persistShortcutOverrides({});
            setDraftByAction({});
            setPendingOverwrite(null);
            setErrorText('');
            setWarningText('');
          }}
        >
          {"Reset All"}
        </Button>
      )}
    >
      {(errorText || warningText || pendingOverwrite) && (
        <div className="mb-2 space-y-2">
          {pendingOverwrite && (
            <div className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3 flex flex-col @xl:flex-row @xl:items-center justify-between gap-3">
              <span className="typography-meta text-foreground">
                {"This combo is already used by another shortcut. Overwrite and clear that other mapping?"}
              </span>
              <div className="flex gap-2 shrink-0">
                <Button type="button" size="xs" className="!font-normal" onClick={confirmOverwrite}>{"Overwrite"}</Button>
                <Button type="button" size="xs" className="!font-normal" variant="ghost" onClick={() => setPendingOverwrite(null)}>{"Cancel"}</Button>
              </div>
            </div>
          )}
          {errorText && (
            <div className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-foreground">
              {errorText}
            </div>
          )}
          {warningText && (
            <div className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3 typography-meta text-foreground">
              {warningText}
            </div>
          )}
        </div>
      )}

      <div>
        {actions.map((action, index) => {
          const isSurfaceSwitch = action.id === 'switch_context_surface';
          const effective = isSurfaceSwitch
            ? getEffectiveShortcutPrefix(action.id, shortcutOverrides)
            : getEffectiveShortcutCombo(action.id, shortcutOverrides);
          const draft = draftByAction[action.id];
          const displayCombo = draft ?? effective;
          const hasDraft = typeof draft === 'string' && normalizeCombo(draft) !== normalizeCombo(effective);
          const isUnassignedDisplay = displayCombo === '' || normalizeCombo(displayCombo) === UNASSIGNED_SHORTCUT;
          const displayValue = capturingActionId === action.id
            ? "Press keys..."
            : isSurfaceSwitch && !isUnassignedDisplay
              ? `${formatShortcutForDisplay(displayCombo)}${" + 1…0"}`
              : formatShortcutForDisplay(displayCombo);

          return (
            <div key={action.id} className={cn("py-1.5", index > 0 && "border-t border-border/40")}>
              <SettingsFieldRow
                label={actionLabel(action.id, action.label)}
                alignEnd={false}
              >
                <Input
                  readOnly
                  value={displayValue}
                  onFocus={() => {
                    setCapturingActionId(action.id);
                    setErrorText('');
                  }}
                  onBlur={() => {
                    if (capturingActionId === action.id) {
                      setCapturingActionId(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();

                    if (event.key === 'Escape') {
                      setCapturingActionId(null);
                      return;
                    }

                    const combo = isSurfaceSwitch ? keyboardEventToPrefixCombo(event) : keyboardEventToCombo(event);
                    if (!combo) {
                      return;
                    }

                    setDraftByAction((current) => ({
                      ...current,
                      [action.id]: combo,
                    }));
                    setCapturingActionId(null);
                    setPendingOverwrite(null);
                    setErrorText('');
                  }}
                  className="h-7 w-40 min-w-0 typography-ui-label text-center"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="!font-normal"
                  onClick={() => {
                    const next = draftByAction[action.id];
                    if (!next) {
                      setErrorText("Capture a shortcut first.");
                      return;
                    }
                    saveCombo(action.id, next);
                  }}
                  disabled={!hasDraft}
                >
                  {"Save Changes"}
                </Button>
                <Button type="button" size="xs" className="!font-normal" variant="ghost" onClick={() => resetOne(action.id)}>
                  {"Reset"}
                </Button>
              </SettingsFieldRow>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
};
