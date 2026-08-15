import React from 'react';
import { cn } from '@/lib/utils';

// Braille animation frames inspired by terminal thinking states (czl9707/agents-are-thinking)
const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const BRAILLE_WAVE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const;
const MATRIX_DOT_FRAMES = ['⠋', '⠙', '⠚', '⠒', '⠂', '⠂', ' ', '⠲', '⠴', '⠦', '⠖', '⠒', '⠐', '⠐', '⠒', '⠓', '⠋'] as const;

export interface AgentThinkingLoaderProps {
  text?: string | null;
  className?: string;
  variant?: 'inline' | 'badge' | 'full';
  animationType?: 'spinner' | 'wave' | 'matrix';
  speedMs?: number;
  showText?: boolean;
}

export const AgentThinkingLoader: React.FC<AgentThinkingLoaderProps> = ({
  text = 'Thinking',
  className,
  variant = 'inline',
  animationType = 'spinner',
  speedMs = 80,
  showText = true,
}) => {
  const [frameIndex, setFrameIndex] = React.useState(0);

  const frames = React.useMemo(() => {
    switch (animationType) {
      case 'wave':
        return BRAILLE_WAVE_FRAMES;
      case 'matrix':
        return MATRIX_DOT_FRAMES;
      case 'spinner':
      default:
        return BRAILLE_SPINNER_FRAMES;
    }
  }, [animationType]);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, speedMs);
    return () => clearInterval(timer);
  }, [frames.length, speedMs]);

  const currentGlyph = frames[frameIndex] ?? frames[0];

  if (variant === 'badge') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-normal',
          'bg-primary/10 text-primary border border-primary/20',
          'transition-opacity duration-300',
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <span className="font-mono text-sm leading-none select-none text-primary" aria-hidden="true">
          {currentGlyph}
        </span>
        {showText && text ? (
          <span className="truncate max-w-[140px] text-[11px] leading-tight tracking-tight">
            {text}
          </span>
        ) : null}
      </span>
    );
  }

  if (variant === 'full') {
    return (
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-lg border border-primary/25 bg-primary/5 px-3 py-1.5 text-sm text-foreground',
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <span
          className="flex h-5 w-5 items-center justify-center font-mono text-base font-semibold text-primary select-none"
          aria-hidden="true"
        >
          {currentGlyph}
        </span>
        {showText && text ? (
          <span className="typography-ui-header text-foreground font-medium truncate">
            {text}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-primary', className)}
      role="status"
      aria-live="polite"
    >
      <span className="font-mono text-sm leading-none select-none text-primary font-bold" aria-hidden="true">
        {currentGlyph}
      </span>
      {showText && text ? (
        <span className="truncate">{text}</span>
      ) : null}
    </span>
  );
};
