import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { SettingsPageMeta } from '@/lib/settings/metadata';
import type { MobileStage } from './settingsViewHelpers';

interface MobileSettingsHeaderProps {
  mobileStage: MobileStage;
  activePageMeta: SettingsPageMeta | null;
  getPageTitle: (slug: any) => string;
  showBackButton: boolean;
  mobileBackButtonLabel: string;
  onBack: () => void;
  showOpenPageSidebarButton: boolean;
  onOpenPageSidebar: () => void;
  isMobileSettingsSearchOpen: boolean;
  setIsMobileSettingsSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mobileSettingsSearchInputRef: React.RefObject<HTMLInputElement | null>;
  settingsSearchQuery: string;
  setSettingsSearchQuery: (query: string) => void;
  handleSettingsSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onClose?: () => void;
  shortcutKey: string;
}

export const MobileSettingsHeader: React.FC<MobileSettingsHeaderProps> = ({
  mobileStage,
  activePageMeta,
  getPageTitle,
  showBackButton,
  mobileBackButtonLabel,
  onBack,
  showOpenPageSidebarButton,
  onOpenPageSidebar,
  isMobileSettingsSearchOpen,
  setIsMobileSettingsSearchOpen,
  mobileSettingsSearchInputRef,
  settingsSearchQuery,
  setSettingsSearchQuery,
  handleSettingsSearchKeyDown,
  onClose,
  shortcutKey,
}) => {
  return (
    <>
      <div
        className={cn(
          'flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3',
          mobileStage !== 'nav' && 'border-b',
          'bg-background',
        )}
        style={mobileStage !== 'nav' ? { borderColor: 'var(--interactive-border)' } : undefined}
      >
        {showBackButton ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={mobileBackButtonLabel}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Icon name="arrow-left-s" className="h-5 w-5" />
          </button>
        ) : null}

        <div className="min-w-0 flex-1 px-2 typography-ui-label font-medium text-foreground truncate">
          {mobileStage === 'nav'
            ? 'Settings'
            : activePageMeta
              ? getPageTitle(activePageMeta.slug)
              : 'Settings'}
        </div>

        {showOpenPageSidebarButton && (
          <button
            type="button"
            onClick={onOpenPageSidebar}
            aria-label={'Open section list'}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Icon name="list-unordered" className="h-5 w-5" />
          </button>
        )}

        {mobileStage === 'nav' ? (
          <button
            type="button"
            onClick={() => {
              const next = !isMobileSettingsSearchOpen;
              setIsMobileSettingsSearchOpen(next);
              if (!next) setSettingsSearchQuery('');
              else window.setTimeout(() => mobileSettingsSearchInputRef.current?.focus(), 0);
            }}
            aria-label={isMobileSettingsSearchOpen ? 'Close search' : 'Search settings'}
            aria-expanded={isMobileSettingsSearchOpen}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Icon name={isMobileSettingsSearchOpen ? 'close' : 'search'} className="h-5 w-5" />
          </button>
        ) : null}

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={'Close settings'}
            title={`Close Settings (${shortcutKey}+,)`}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        )}
      </div>

      {mobileStage === 'nav' && isMobileSettingsSearchOpen ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2"
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          <div className="flex h-10 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-transparent px-2 text-muted-foreground focus-within:ring-2 focus-within:ring-primary/40">
            <Icon name="search" className="h-4 w-4 shrink-0" />
            <input
              ref={mobileSettingsSearchInputRef}
              value={settingsSearchQuery}
              onChange={(event) => setSettingsSearchQuery(event.target.value)}
              onKeyDown={handleSettingsSearchKeyDown}
              placeholder={'Search settings'}
              aria-label={'Search settings'}
              className="typography-ui-label min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {settingsSearchQuery.trim().length > 0 ? (
              <button
                type="button"
                onClick={() => setSettingsSearchQuery('')}
                aria-label={'Clear settings search'}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
};
