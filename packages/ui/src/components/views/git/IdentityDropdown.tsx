import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import type { GitIdentityProfile } from '@/lib/api/types';

const IDENTITY_ICON_MAP: Record<string, IconName> = {
  branch: 'git-branch',
  briefcase: 'briefcase',
  house: 'home',
  graduation: 'graduation-cap',
  code: 'code',
  heart: 'heart',
  user: 'user-3',
  fingerprint: 'fingerprint',
};

const IDENTITY_COLOR_MAP: Record<string, string> = {
  keyword: 'var(--syntax-keyword)',
  error: 'var(--status-error)',
  string: 'var(--syntax-string)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
  success: 'var(--status-success)',
  info: 'var(--status-info)',
  warning: 'var(--status-warning)',
};

function getIdentityColor(token?: string | null) {
  if (!token) {
    return 'var(--primary)';
  }
  return IDENTITY_COLOR_MAP[token] || 'var(--primary)';
}

interface IdentityIconProps {
  icon?: string | null;
  className?: string;
  colorToken?: string | null;
}

const IdentityIcon: React.FC<IdentityIconProps> = ({ icon, className, colorToken }) => {
  const iconName = IDENTITY_ICON_MAP[icon ?? 'branch'] ?? 'user-3';
  return (
    <Icon
      name={iconName}
      className={className}
      style={{ color: getIdentityColor(colorToken) }}
    />
  );
};

interface IdentityDropdownProps {
  activeProfile: GitIdentityProfile | null;
  identities: GitIdentityProfile[];
  onSelect: (profile: GitIdentityProfile) => void;
  isApplying: boolean;
  iconOnly?: boolean;
}

export const IdentityDropdown: React.FC<IdentityDropdownProps> = ({
  activeProfile,
  identities,
  onSelect,
  isApplying,
  iconOnly = false,
}) => {

  const isDisabled = isApplying || identities.length === 0;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 min-w-0 max-w-[15rem] justify-start gap-1.5 px-2 py-1 typography-ui-label"
              style={{ color: getIdentityColor(activeProfile?.color) }}
              disabled={isDisabled}
            >
              {isApplying ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <IdentityIcon
                  icon={activeProfile?.icon}
                  colorToken={activeProfile?.color}
                  className="size-4"
                />
              )}
              {!iconOnly && (
                <span className="min-w-0 flex-1 truncate text-left">
                  {activeProfile?.name || "No identity"}
                </span>
              )}
              <Icon name="arrow-down-s" className="size-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>{"Git identity"}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        {identities.length === 0 ? (
          <div className="px-2 py-1.5">
            <p className="typography-meta text-muted-foreground">
              {"No profiles available to apply."}
            </p>
          </div>
        ) : (
          identities.map((profile) => {
            const isSelected = activeProfile?.id === profile.id;
            return (
              <DropdownMenuItem key={profile.id} onSelect={() => onSelect(profile)}>
                <span className="flex items-center gap-2">
                  <IdentityIcon
                    icon={profile.icon}
                    colorToken={profile.color}
                    className="size-4"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="typography-ui-label text-foreground">
                      {profile.name}
                    </span>
                    <span className="typography-meta text-muted-foreground">
                      {profile.userEmail}
                    </span>
                  </span>
                  {isSelected ? (
                    <Icon name="check" className="ml-auto size-4 text-foreground" />
                  ) : null}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
