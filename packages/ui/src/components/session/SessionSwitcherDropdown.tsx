import React, { Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

const LazySwitcherContent = React.lazy(() => import('./SessionSwitcherContent'));

type SwitcherVariant = 'default' | 'compact';

type SessionSwitcherDropdownProps = {
  children: React.ReactNode;
  variant?: SwitcherVariant;
  scopeProjectId?: string | null;
  align?: 'start' | 'center' | 'end';
};

export function SessionSwitcherDropdown({
  children,
  variant = 'default',
  scopeProjectId = null,
  align = 'start',
}: SessionSwitcherDropdownProps): React.ReactElement {
  const { t } = useTranslation();
  const isOpen = useUIStore((state) => state.isSessionDropdownOpen);
  const setOpen = useUIStore((state) => state.setSessionDropdownOpen);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={6}
        className={cn(
          'overflow-hidden p-1 max-w-[calc(100vw-32px)]',
          variant === 'compact' ? 'w-[280px]' : 'w-[360px]',
        )}
      >
        {isOpen ? (
          <Suspense fallback={<div className="px-3 py-4 text-center typography-meta text-muted-foreground">{t('Loading…')}</div>}>
            <LazySwitcherContent onSelect={() => setOpen(false)} variant={variant} scopeProjectId={scopeProjectId} />
          </Suspense>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


