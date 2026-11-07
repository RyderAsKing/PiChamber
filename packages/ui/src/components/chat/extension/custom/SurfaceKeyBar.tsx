import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { encodeTerminalKey, textEditInput } from '@/lib/pi/terminal-keys';
import { cn } from '@/lib/utils';
import { sendSurfaceInput } from './surfaceTransport';

type BarKey = { label: string; data: string; icon?: 'arrow-left' | 'arrow-up' | 'arrow-down' | 'arrow-right' };

const KEYS: BarKey[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Left', data: '\x1b[D', icon: 'arrow-left' },
  { label: 'Up', data: '\x1b[A', icon: 'arrow-up' },
  { label: 'Down', data: '\x1b[B', icon: 'arrow-down' },
  { label: 'Right', data: '\x1b[C', icon: 'arrow-right' },
  { label: 'Enter', data: '\r' },
];

/**
 * Keeps the hidden input non-empty, so a phone keyboard's Backspace on it
 * has something to delete and reports `deleteContentBackward`.
 */
const SENTINEL = ' ';

/**
 * The keys a touch screen has no way to type (Esc, Tab, arrows, Enter) and a
 * Keyboard button that brings up the phone keyboard for text. Typed text goes
 * through a hidden input: keys with a terminal sequence of their own are sent
 * on keydown, text as it lands in the input, including a phone keyboard's
 * in-place edits while composing a word.
 */
export const SurfaceKeyBar: React.FC<{ sessionId: string; surfaceId: string; className?: string }> = ({
  sessionId,
  surfaceId,
  className,
}) => {
  const input = React.useRef<HTMLInputElement | null>(null);
  const sent = React.useRef('');
  const [typing, setTyping] = React.useState(false);
  const send = (data: string) => {
    if (data) sendSurfaceInput(sessionId, surfaceId, [data]);
  };

  const reset = () => {
    sent.current = '';
    const element = input.current;
    if (!element) return;
    element.value = SENTINEL;
    element.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };

  const onInput = (event: React.FormEvent<HTMLInputElement>) => {
    const element = event.currentTarget;
    const composing = (event.nativeEvent as InputEvent).isComposing;
    if (!element.value.startsWith(SENTINEL)) {
      // The sentinel itself was deleted: one Backspace past the text sent.
      send(textEditInput(sent.current, '') + (element.value === '' ? '\x7f' : element.value));
      reset();
      return;
    }
    const current = element.value.slice(SENTINEL.length);
    send(textEditInput(sent.current, current));
    sent.current = current;
    if (!composing) reset();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key === 'Unidentified' || [...event.key].length === 1) return;
    const data = encodeTerminalKey(event);
    if (data === null) return;
    event.preventDefault();
    send(data);
  };

  return (
    <div role="toolbar" aria-label="Extension keys" className={cn('relative flex items-center gap-0.5 overflow-x-auto', className)}>
      {KEYS.map((key) => (
        <Button
          key={key.label}
          type="button"
          variant="outline"
          size="xs"
          className={cn('shrink-0 font-sans', key.icon ? 'h-7 w-6 px-0 has-[>svg]:px-0' : 'h-7 px-1.5')}
          aria-label={key.icon ? key.label : undefined}
          // Keep focus (and the phone keyboard) where it is.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => send(key.data)}
        >
          {key.icon ? <Icon name={key.icon} className="size-3.5" /> : key.label}
        </Button>
      ))}
      <Button
        type="button"
        variant="chip"
        size="xs"
        className="ml-auto h-7 shrink-0 px-1.5 font-sans"
        aria-pressed={typing}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (typing) input.current?.blur();
          else input.current?.focus({ preventScroll: true });
        }}
      >
        Keyboard
      </Button>
      <input
        ref={input}
        aria-label="Type to the extension"
        className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
        defaultValue={SENTINEL}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="enter"
        onFocus={() => {
          reset();
          setTyping(true);
        }}
        onBlur={() => setTyping(false)}
        onInput={onInput}
        onCompositionEnd={reset}
        onKeyDown={onKeyDown}
      />
    </div>
  );
};
