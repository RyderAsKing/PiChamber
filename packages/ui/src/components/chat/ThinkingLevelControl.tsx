import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import {
  nearestDiscreteIndex,
  thinkingLevelLabel,
} from '@/lib/pi/thinking';
import type { PiThinkingLevel } from '@/lib/pi/types';
import { cn } from '@/lib/utils';

const thinkingOptions = (
  levels: readonly PiThinkingLevel[],
  allowUnset: boolean,
): Array<PiThinkingLevel | undefined> => (
  allowUnset ? [undefined, ...levels] : [...levels]
);

const optionKey = (option: PiThinkingLevel | undefined) => option ?? 'default';

const tickPercent = (index: number, maxIndex: number) => (
  maxIndex === 0 ? 50 : (index / maxIndex) * 100
);

/** Half the track height (`h-5` = 20px) so ticks sit inside the rounded caps. */
const TRACK_INSET_PX = 10;

const THINKING_POPOVER_COLLISION = {
  side: 'none',
  align: 'none',
  fallbackAxisSide: 'none',
} as const;

function WidthReservedText({
  options,
  value,
  prefix = '',
  className,
}: {
  options: ReadonlyArray<PiThinkingLevel | undefined>;
  value: string;
  prefix?: string;
  className?: string;
}) {
  return (
    <span className={cn('grid min-w-0 justify-items-start', className)}>
      {options.map((option) => (
        <span
          key={optionKey(option)}
          className="invisible col-start-1 row-start-1 overflow-hidden whitespace-nowrap"
          aria-hidden="true"
        >
          {prefix}{thinkingLevelLabel(option)}
        </span>
      ))}
      <span className="col-start-1 row-start-1 truncate">{prefix}{value}</span>
    </span>
  );
}

function ThinkingLevelSlider({
  levels,
  value,
  onChange,
  allowUnset = true,
}: {
  levels: readonly PiThinkingLevel[];
  value: PiThinkingLevel | undefined;
  onChange: (next: PiThinkingLevel | undefined) => void;
  allowUnset?: boolean;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const options = thinkingOptions(levels, allowUnset);
  const selectedIndex = Math.max(0, options.findIndex((option) => option === value));
  const maxIndex = Math.max(0, options.length - 1);
  const fraction = maxIndex === 0 ? 0 : selectedIndex / maxIndex;
  const valueText = thinkingLevelLabel(options[selectedIndex]);

  const emitFromClientX = React.useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || options.length === 0) return;
    const nextIndex = nearestDiscreteIndex((clientX - rect.left) / rect.width, options.length);
    const next = options[nextIndex];
    if (next !== value) onChange(next);
  }, [onChange, options, value]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    emitFromClientX(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    emitFromClientX(event.clientX);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextIndex = Math.min(maxIndex, selectedIndex + 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextIndex = Math.max(0, selectedIndex - 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = maxIndex;
    if (nextIndex === null || nextIndex === selectedIndex) return;
    event.preventDefault();
    onChange(options[nextIndex]);
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Thinking"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={maxIndex}
      aria-valuenow={selectedIndex}
      aria-valuetext={valueText}
      className="cursor-pointer touch-none select-none px-4 py-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] rounded-full"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onKeyDown={handleKeyDown}
    >
      <div className="relative h-8">
        <div className="absolute inset-x-0 top-1/2 h-5 -translate-y-1/2 rounded-full bg-muted" />
        <div
          className="absolute left-0 top-1/2 h-5 -translate-y-1/2 rounded-full bg-primary"
          style={{
            width: `calc(${TRACK_INSET_PX}px + (100% - ${TRACK_INSET_PX * 2}px) * ${fraction})`,
          }}
        />
        <div
          ref={trackRef}
          className="absolute inset-y-0"
          style={{ left: TRACK_INSET_PX, right: TRACK_INSET_PX }}
        >
          {options.map((option, index) => {
            const percent = tickPercent(index, maxIndex);
            const filled = index <= selectedIndex;
            return (
              <div
                key={optionKey(option)}
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full',
                  filled ? 'bg-primary-foreground/50' : 'bg-foreground/35',
                )}
                style={{ left: `${percent}%` }}
              />
            );
          })}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-0">
            <div
              className="w-full"
              style={{ transform: `translateX(${tickPercent(selectedIndex, maxIndex)}%)` }}
            >
              <div className="absolute left-0 top-0 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ThinkingLevelPicker({
  levels,
  value,
  onChange,
  allowUnset = true,
}: {
  levels: readonly PiThinkingLevel[];
  value: PiThinkingLevel | undefined;
  onChange: (next: PiThinkingLevel | undefined) => void;
  allowUnset?: boolean;
}) {
  const options = thinkingOptions(levels, allowUnset);

  return (
    <div className="w-full px-4 pt-3.5 pb-2">
      <ThinkingLevelSlider
        levels={levels}
        value={value}
        onChange={onChange}
        allowUnset={allowUnset}
      />
      <div className="mt-1.5 flex justify-between px-4 typography-micro text-muted-foreground">
        <span>{thinkingLevelLabel(options[0])}</span>
        <span className="text-right">{thinkingLevelLabel(options[options.length - 1])}</span>
      </div>
    </div>
  );
}

export function ThinkingLevelControl({
  levels,
  value,
  onChange,
  compact,
  keepLabel = false,
  onCompactOpen,
  buttonHeight,
  iconSize,
  textSize,
  isMobile,
  isDesktop,
}: {
  levels: readonly PiThinkingLevel[];
  value: PiThinkingLevel | undefined;
  onChange: (next: PiThinkingLevel | undefined) => void;
  compact?: boolean;
  keepLabel?: boolean;
  onCompactOpen?: () => void;
  buttonHeight: string;
  iconSize: string;
  textSize: string;
  isMobile?: boolean;
  isDesktop?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const displayLabel = thinkingLevelLabel(value);
  const isDefault = !value;
  const colorClass = isDefault ? 'text-muted-foreground' : 'text-foreground';
  const labelOptions = thinkingOptions(levels, true);

  const trigger = (
    <button
      type="button"
      onClick={compact ? onCompactOpen : undefined}
      className={cn(
        'model-controls__variant-trigger flex items-center gap-1.5 min-w-0',
        buttonHeight,
        'cursor-pointer hover:bg-transparent hover:opacity-70',
        compact ? 'transition-opacity focus:outline-none' : 'transition-opacity',
      )}
      aria-label={`Thinking: ${displayLabel}`}
    >
      <Icon name="brain-ai-3" className={cn(iconSize, 'flex-shrink-0', colorClass)} />
      <WidthReservedText
        options={labelOptions}
        value={displayLabel}
        className={cn(
          'model-controls__variant-label',
          textSize,
          'font-normal',
          keepLabel ? 'min-w-max whitespace-nowrap' : null,
          compact && isMobile && !keepLabel && 'max-w-[60px]',
          !compact && isDesktop && 'max-w-[180px]',
          colorClass,
        )}
      />
    </button>
  );

  if (compact) return trigger;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={600} {...(open ? { open: false } : {})}>
        <TooltipTrigger asChild>
          <Popover.Trigger render={trigger} />
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <WidthReservedText
            options={labelOptions}
            value={displayLabel}
            prefix="Thinking: "
            className="typography-meta"
          />
        </TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner
          className="app-region-no-drag z-50"
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={8}
          collisionAvoidance={THINKING_POPOVER_COLLISION}
        >
          <Popover.Popup
            className={cn(dropdownMenuPopupClass, 'w-[min(17.5rem,calc(100vw-2rem))] p-0 max-h-none')}
            style={{
              backgroundColor: 'var(--surface-elevated)',
              color: 'var(--surface-elevated-foreground)',
            }}
          >
            <ThinkingLevelPicker levels={levels} value={value} onChange={onChange} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
