import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ComposerVoiceButtonProps {
  available: boolean;
  disabled?: boolean;
  className?: string;
  iconClassName?: string;
  onStart(): void;
}

export function ComposerVoiceButton({ available, disabled, className, iconClassName, onStart }: ComposerVoiceButtonProps) {
  if (!available) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      disabled={disabled}
      onClick={onStart}
      title="Start dictation"
      aria-label="Start dictation"
    >
      <Icon name="mic" className={cn('size-4', iconClassName)} />
    </Button>
  );
}
