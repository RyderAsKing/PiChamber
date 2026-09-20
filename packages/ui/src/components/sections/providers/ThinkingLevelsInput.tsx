import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';

type ThinkingLevelsInputProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hasError?: boolean;
  id: string;
};

const parseValues = (value: string): string[] =>
  value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);

export const ThinkingLevelsInput: React.FC<ThinkingLevelsInputProps> = ({
  value,
  onChange,
  disabled = false,
  hasError = false,
  id,
}) => {
  const [draft, setDraft] = React.useState('');
  const values = parseValues(value);

  const addDraft = () => {
    const additions = parseValues(draft);
    if (additions.length === 0) return;
    const next = [...values];
    for (const addition of additions) {
      if (!next.includes(addition)) next.push(addition);
    }
    onChange(next.join('\n'));
    setDraft('');
  };

  return (
    <div className="space-y-2">
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Configured thinking levels">
          {values.map((entry) => (
            <Button
              key={entry}
              type="button"
              variant="chip"
              size="xs"
              disabled={disabled}
              aria-label={`Remove ${entry}`}
              onClick={() => onChange(values.filter((value) => value !== entry).join('\n'))}
            >
              <span className="font-mono text-xs normal-case">{entry}</span>
              <Icon name="close" className="size-3" aria-hidden />
            </Button>
          ))}
        </div>
      ) : null}
      <Input
        id={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            addDraft();
          }
        }}
        onBlur={addDraft}
        placeholder="low-effort"
        className="h-8 font-mono text-xs"
        disabled={disabled}
        aria-invalid={hasError || undefined}
        aria-label="Add thinking level"
      />
      <p className={SETTINGS_HELPER_CLASS}>
        Press Enter or comma to add a value. Start with off, minimal, low, medium, high, xhigh, or max.
      </p>
    </div>
  );
};
