import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * List toolbar menus (t3code `PullRequestListFilters` contract, PiChamber
 * tokens): a single Filters menu button (icon + active-count pill) holding
 * State and Involvement radio submenus, plus a Sort menu. Triggers are
 * borderless ghost Buttons matching the Git/Files header controls; menus use
 * the shared DropdownMenu primitive.
 *
 * Filters/Sort always render inline in the list toolbar (second row) with
 * ghost chrome (h-8 matching the search input). Only the action controls (Refresh + primary action)
 * portal into a host header slot via `GitHubListView`; they never move
 * Filters/Sort.
 */

/**
 * Which host header receives a portalled action button. `desktop` targets
 * the ContextPanel `h-10` header (ghost `h-8 w-8` icon buttons matching
 * the panel's own header buttons); `drawer` targets the mobile/tablet
 * `MobileSurfaceHeader` actions (ghost 36px `size-9` touch targets).
 */
export type GitHubHeaderActionsPresentation = 'desktop' | 'drawer';

type GitHubFilterOption = { id: string; label: string };

const SubmenuRadioGroup: React.FC<{
  label: string;
  value: string;
  options: GitHubFilterOption[];
  currentLabel: string;
  onChange: (id: string) => void;
}> = ({ label, value, options, currentLabel, onChange }) => {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">{label}</span>
        <span className="min-w-0 max-w-32 truncate typography-micro text-muted-foreground">
          {currentLabel}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-48">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (typeof next === 'string' && next !== value) onChange(next);
          }}
        >
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick={false}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

export const GitHubFiltersMenu: React.FC<{
  stateValue: string;
  stateOptions: GitHubFilterOption[];
  onStateChange: (id: string) => void;
  involvementValue: string;
  involvementOptions: GitHubFilterOption[];
  onInvolvementChange: (id: string) => void;
  /** Issues labels filter (comma-separated); renders a Labels entry when set. */
  labelsValue?: string;
  onLabelsChange?: (value: string) => void;
}> = ({
  stateValue,
  stateOptions,
  onStateChange,
  involvementValue,
  involvementOptions,
  onInvolvementChange,
  labelsValue,
  onLabelsChange,
}) => {
  const { t } = useTranslation();
  const stateLabel = stateOptions.find((option) => option.id === stateValue)?.label ?? stateValue;
  const involvementLabel =
    involvementOptions.find((option) => option.id === involvementValue)?.label ?? involvementValue;
  const labelsActive = (labelsValue ?? '').trim().length > 0;
  const activeCount =
    (stateValue !== stateOptions[0]?.id ? 1 : 0) +
    (involvementValue !== involvementOptions[0]?.id ? 1 : 0) +
    (labelsActive ? 1 : 0);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("Filters")}
          title={t("Filters")}
          className="h-8 shrink-0 gap-1.5 px-2 normal-case"
        >
          <Icon name="equalizer" className="size-4" aria-hidden="true" />
          <span>{t('Filters')}</span>
          {activeCount > 0 ? (
            <span className="rounded-full bg-[var(--surface-muted)] px-1.5 typography-micro tabular-nums text-muted-foreground">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <SubmenuRadioGroup
          label={t("State")}
          value={stateValue}
          options={stateOptions}
          currentLabel={stateLabel}
          onChange={onStateChange}
        />
        <SubmenuRadioGroup
          label={t("Involvement")}
          value={involvementValue}
          options={involvementOptions}
          currentLabel={involvementLabel}
          onChange={onInvolvementChange}
        />
        {onLabelsChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('Labels')}</DropdownMenuLabel>
            <div className="px-2 pb-2">
              <Input
                value={labelsValue ?? ''}
                onChange={(event) => onLabelsChange(event.target.value)}
                placeholder="bug, enhancement"
                aria-label={t("Filter by labels")}
                className="h-7"
              />
              <p className="mt-1 typography-micro text-muted-foreground">
                {t('Comma-separated. Or type label:bug in search.')}
              </p>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const GitHubSortMenu: React.FC<{
  value: string;
  options: GitHubFilterOption[];
  onChange: (id: string) => void;
  ariaLabel: string;
}> = ({ value, options, onChange, ariaLabel }) => {
  const { t } = useTranslation();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={ariaLabel}
          title={ariaLabel}
          className="h-8 w-8 shrink-0 p-0"
        >
          <Icon name="expand-up-down" className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (typeof next === 'string' && next !== value) onChange(next);
          }}
        >
          <DropdownMenuLabel>{t('Sort')}</DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const GitHubRefreshButton: React.FC<{
  isRefreshing: boolean;
  onRefresh: () => void;
  label?: string;
  /**
   * `toolbar` renders the bordered toolbar trigger inline; `desktop` renders
   * a ghost `h-8 w-8` icon button for the ContextPanel header;
   * `drawer` renders a ghost 36px (`size="icon"`) button for the
   * mobile/tablet `MobileSurfaceHeader` actions.
   */
  presentation?: 'toolbar' | GitHubHeaderActionsPresentation;
}> = ({ isRefreshing, onRefresh, label, presentation = 'toolbar' }) => {
  const { t } = useTranslation();
  if (presentation === 'desktop') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRefresh}
        disabled={isRefreshing}
        title={label ?? t('Refresh')}
        aria-label={label ?? t('Refresh GitHub data')}
        className="h-8 w-8 shrink-0 p-0"
      >
        <Icon name="refresh" className={cn('size-4', isRefreshing && 'animate-spin')} aria-hidden="true" />
      </Button>
    );
  }
  if (presentation === 'drawer') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRefresh}
        disabled={isRefreshing}
        title={label ?? t('Refresh')}
        aria-label={label ?? t('Refresh GitHub data')}
        className="shrink-0"
      >
        <Icon name="refresh" className={cn('size-4', isRefreshing && 'animate-spin')} aria-hidden="true" />
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onRefresh}
      disabled={isRefreshing}
      title={label ?? t('Refresh')}
      aria-label={label ?? t('Refresh GitHub data')}
      className="h-8 w-8 shrink-0 p-0"
    >
      <Icon name="refresh" className={cn('size-4', isRefreshing && 'animate-spin')} aria-hidden="true" />
    </Button>
  );
};
