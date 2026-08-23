import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { reportSettingsSaveState } from '@/lib/persistence';
import {
    MAX_COMMAND_TRIGGERS,
    sanitizeCommandTriggers,
    type CommandTrigger,
} from '@/lib/pi/command-triggers';
import { keyToShortcutToken, normalizeCombo } from '@/lib/shortcuts';
import { Icon } from '@/components/icon/Icon';
import {
    SettingsSection,
    SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);

const keyboardEventToCombo = (event: React.KeyboardEvent<HTMLInputElement>): string | null => {
    if (MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) parts.push('mod');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');
    const token = keyToShortcutToken(event.key);
    if (!token) return null;
    parts.push(token);
    const combo = normalizeCombo(parts.join('+'));
    // Bare keys would hijack typing; require at least one modifier.
    return parts.length > 1 ? combo : null;
};

const TriggerRow: React.FC<{
    trigger: CommandTrigger;
    index: number;
    onChange: (next: CommandTrigger) => void;
    onRemove: () => void;
}> = ({ trigger, index, onChange, onRemove }) => {
    const inputClass = 'h-9 w-full bg-transparent text-sm';
    return (
        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center">
            <Input
                value={trigger.label}
                placeholder="Label"
                aria-label={`Trigger ${index + 1} label`}
                onChange={(event) => onChange({ ...trigger, label: event.target.value })}
                className={cn(inputClass, '@xl:w-36')}
            />
            <div className="flex items-center gap-1.5">
                <span className="text-sm text-muted-foreground">/</span>
                <Input
                    value={trigger.command}
                    placeholder="command"
                    aria-label={`Trigger ${index + 1} command`}
                    onChange={(event) => onChange({ ...trigger, command: event.target.value })}
                    className={cn(inputClass, 'w-40')}
                />
            </div>
            <Input
                value={trigger.args ?? ''}
                placeholder="Arguments (optional)"
                aria-label={`Trigger ${index + 1} arguments`}
                onChange={(event) => onChange({ ...trigger, args: event.target.value })}
                className={cn(inputClass, 'flex-1')}
            />
            <input
                value={trigger.combo ? trigger.combo.replace(/\+/g, '+') : ''}
                placeholder="Keybinding"
                aria-label={`Trigger ${index + 1} keybinding`}
                readOnly
                onKeyDown={(event) => {
                    const combo = keyboardEventToCombo(event);
                    if (!combo) return;
                    event.preventDefault();
                    onChange({ ...trigger, combo });
                }}
                className={cn(inputClass, 'w-32 rounded-md border')}
            />
            <Button variant="ghost" size="icon" onClick={onRemove} aria-label={`Remove trigger ${trigger.label}`}>
                <Icon name="close" className="size-4" />
            </Button>
        </div>
    );
};

/**
 * User-authored command triggers: quick-action buttons near the composer and
 * optional global keybindings that fire slash commands.
 */
export const CommandTriggersSettings: React.FC = () => {
    const triggers = useUIStore((state) => state.commandTriggers);

    const persist = React.useCallback(async (next: CommandTrigger[]) => {
        useUIStore.setState({ commandTriggers: next });
        try {
            await updateDesktopSettings({ commandTriggers: next });
        } catch {
            reportSettingsSaveState('error');
        }
    }, []);

    const updateAt = (index: number, next: CommandTrigger) => {
        const draft = triggers.map((trigger, i) => (i === index ? next : trigger));
        void persist(sanitizeCommandTriggers(draft) ?? []);
    };

    const removeAt = (index: number) => {
        const draft = triggers.filter((_, i) => i !== index);
        void persist(draft);
    };

    const addTrigger = () => {
        if (triggers.length >= MAX_COMMAND_TRIGGERS) return;
        void persist([
            ...triggers,
            { id: `trigger-${Date.now().toString(36)}`, label: '', command: '' },
        ]);
    };

    return (
        <SettingsSection title="Command triggers" divider={false} settingsItem="shortcuts.command-triggers">
            <SettingsFieldRow
                label="Quick actions"
                info="Buttons above the composer and optional keybindings that run a slash command in the current session. Keybindings must include a modifier and never shadow built-in shortcuts."
            >
                <Button size="sm" variant="outline" onClick={addTrigger} disabled={triggers.length >= MAX_COMMAND_TRIGGERS}>
                    Add trigger
                </Button>
            </SettingsFieldRow>
            {triggers.length > 0 && (
                <div className="flex flex-col gap-2 pb-1">
                    {triggers.map((trigger, index) => (
                        <TriggerRow
                            key={trigger.id}
                            trigger={trigger}
                            index={index}
                            onChange={(next) => updateAt(index, next)}
                            onRemove={() => removeAt(index)}
                        />
                    ))}
                </div>
            )}
            {triggers.length === 0 && (
                <p className="pb-2 text-sm text-muted-foreground">
                    No command triggers yet. Add one to pin a slash command as a button.
                </p>
            )}
        </SettingsSection>
    );
};
