import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  if (!available) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      disabled={disabled}
      onClick={onStart}
      title={t("Start dictation")}
      aria-label={t("Start dictation")}
    >
      <Icon name="mic" className={cn('size-4', iconClassName)} />
    </Button>
  );
}
