import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import type { TerminalModifier as Modifier, TerminalQuickKey as MobileKey } from '@/lib/terminalInput';

export type TerminalQuickKeysProps = {
  isTouchTerminal: boolean;
  activeModifier: Modifier | null;
  disabled: boolean;
  onKeyPress: (key: MobileKey) => void;
  onModifierToggle: (modifier: Modifier) => void;
};

export const TerminalQuickKeys: React.FC<TerminalQuickKeysProps> = ({
  isTouchTerminal,
  activeModifier,
  disabled,
  onKeyPress,
  onModifierToggle,
}) => {
  const quickKeySize: 'lg' | 'xs' = isTouchTerminal ? 'lg' : 'xs';
  const quickKeyIconClass = isTouchTerminal ? 'w-10 p-0' : 'w-9 p-0';

  const preserveTerminalFocus = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (isTouchTerminal) event.preventDefault();
  };

  return (
    <>
      <Button
        type="button"
        size={quickKeySize}
        variant="outline"
        onPointerDown={preserveTerminalFocus}
        onClick={() => onKeyPress('esc')}
        disabled={disabled}
      >
        {"Esc"}
      </Button>
      <Button
        type="button"
        size={quickKeySize}
        variant="outline"
        className={quickKeyIconClass}
        onPointerDown={preserveTerminalFocus}
        onClick={() => onKeyPress('tab')}
        disabled={disabled}
      >
        <Icon name="arrow-right" className="h-4 w-4" />
        <span className="sr-only">{"Tab"}</span>
      </Button>
      <Button
        type="button"
        size={quickKeySize}
        variant="chip"
        aria-pressed={activeModifier === 'ctrl'}
        className={isTouchTerminal ? 'px-3' : 'px-2'}
        onPointerDown={preserveTerminalFocus}
        onClick={() => onModifierToggle('ctrl')}
        disabled={disabled}
      >
        <span className="text-xs font-medium">{"Ctrl"}</span>
        <span className="sr-only">{"Control modifier"}</span>
      </Button>
      <Button
        type="button"
        size={quickKeySize}
        variant="chip"
        aria-pressed={activeModifier === 'alt'}
        className={isTouchTerminal ? 'px-3' : 'px-2'}
        onPointerDown={preserveTerminalFocus}
        onClick={() => onModifierToggle('alt')}
        disabled={disabled}
      >
        <span className="text-xs font-medium">{"Alt"}</span>
        <span className="sr-only">{"Alt modifier"}</span>
      </Button>
      <Button
        type="button"
        size={quickKeySize}
        variant="outline"
        className={quickKeyIconClass}
        onPointerDown={preserveTerminalFocus}
        onClick={() => onKeyPress('arrow-up')}
        disabled={disabled}
      >
        <Icon name="arrow-up" />
        <span className="sr-only">{"Arrow up"}</span>
      </Button>
      <Button
        type="button"
        size={quickKeySize}
        variant="outline"
        className={quickKeyIconClass}
        onPointerDown={preserveTerminalFocus}
        onClick={() => onKeyPress('arrow-left')}
        disabled={disabled}
      >
        <Icon name="arrow-left" />
        <span className="sr-only">{"Arrow left"}</span>
      </Button>
      <Button
        type="button"
        size={quickKeySize}
        variant="outline"
        className={quickKeyIconClass}
        onPointerDown={preserveTerminalFocus}
        onClick={() => onKeyPress('arrow-down')}
        disabled={disabled}
      >
        <Icon name="arrow-down" />
        <span className="sr-only">{"Arrow down"}</span>
      </Button>
      <Button
        type="button"
        size={quickKeySize}
        variant="outline"
        className={quickKeyIconClass}
        onPointerDown={preserveTerminalFocus}
        onClick={() => onKeyPress('arrow-right')}
        disabled={disabled}
      >
        <Icon name="arrow-right" />
        <span className="sr-only">{"Arrow right"}</span>
      </Button>
      <Button
        type="button"
        size={quickKeySize}
        variant="outline"
        className={quickKeyIconClass}
        onPointerDown={preserveTerminalFocus}
        onClick={() => onKeyPress('enter')}
        disabled={disabled}
      >
        <Icon name="arrow-go-back" />
        <span className="sr-only">{"Enter"}</span>
      </Button>
    </>
  );
};
