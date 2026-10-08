import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

export type TerminalTabDropdownItem = {
  id: string;
  label: string;
  title?: string;
  icon?: React.ReactNode;
  closeLabel: string;
};

type Props = {
  items: TerminalTabDropdownItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
  disabled?: boolean;
};

/**
 * Switcher for a directory's terminal sessions. xterm tabs render side by
 * side poorly in narrow surfaces (panel, mobile), so the directory exposes
 * a single value-picker: the active tab label plus one menu row per tab.
 */
export const TerminalTabDropdown: React.FC<Props> = ({
  items,
  activeId,
  onSelect,
  onClose,
  onCreate,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const activeItem = items.find((item) => item.id === activeId) ?? items[0] ?? null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={activeItem ? t('Switch terminal, current: {{label}}', { label: activeItem.label }) : t('Switch terminal')}
          aria-label={activeItem ? t('Switch terminal, current: {{label}}', { label: activeItem.label }) : t('Switch terminal')}
          className="h-8 min-w-0 max-w-full justify-start gap-1.5 px-2 py-1 normal-case"
        >
          {activeItem?.icon ?? <Icon name="terminal" className="size-4 shrink-0" />}
          <span className="min-w-0 truncate font-medium text-left">{activeItem?.label ?? t('Terminal')}</span>
          <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {items.map((item) => {
          const isActive = item.id === (activeItem?.id ?? activeId);
          return (
            <DropdownMenuItem
              key={item.id}
              title={item.title ?? item.label}
              onClick={() => onSelect(item.id)}
              className="group/tab min-w-0"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {item.icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </span>
              {isActive ? (
                <Icon name="check" className="size-3.5 shrink-0 text-primary" />
              ) : null}
              <button
                type="button"
                title={item.closeLabel}
                aria-label={item.closeLabel}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onClose(item.id);
                }}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/tab:opacity-100"
              >
                <Icon name="close" className="size-3" />
              </button>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onCreate}>
          <Icon name="add" className="size-3.5" />
          {t('New tab')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
