import React from 'react';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';
import { cn } from '@/lib/utils';

const Bar: React.FC<{
  width: string;
  tone?: string;
  className?: string;
}> = ({ width, tone = 'bg-foreground/60', className }) => (
  <div className={cn('h-[3px] rounded-full', tone, width, className)} />
);

const FolderRow: React.FC<{
  width: string;
  selected?: boolean;
  chevron?: boolean;
}> = ({ width, selected = false, chevron = false }) => (
  <div
    className={cn(
      'flex items-center gap-[4px] rounded-[3px] px-[3px] py-[2px]',
      selected && 'bg-interactive-selection',
    )}
  >
    <div className="h-[5px] w-[6px] shrink-0 rounded-[1.5px] bg-foreground/35" />
    <Bar tone="bg-foreground/60" width={width} />
    {chevron && (
      <div className="ml-auto h-[3px] w-[3px] shrink-0 rounded-full bg-foreground/20" />
    )}
  </div>
);

const CardRow: React.FC<{
  title: string;
  details: string;
  selected?: boolean;
}> = ({ title, details, selected = false }) => (
  <div
    className={cn(
      'flex flex-col gap-[3px] rounded-[3px] px-[3px] py-[3px]',
      selected && 'bg-interactive-selection',
    )}
  >
    <div className="flex items-center">
      <Bar tone="bg-foreground/60" width={title} />
      <div className="ml-auto h-[3px] w-[5px] shrink-0 rounded-full bg-foreground/20" />
    </div>
    <Bar tone="bg-foreground/20" width={details} />
  </div>
);

const TreeRow: React.FC<{
  width: string;
  selected?: boolean;
}> = ({ width, selected = false }) => (
  <div
    className={cn(
      'flex items-center rounded-[3px] py-[2px] pl-[13px] pr-[3px]',
      selected && 'bg-interactive-selection',
    )}
  >
    <Bar tone={selected ? 'bg-foreground/60' : 'bg-foreground/35'} width={width} />
  </div>
);

/** Schematic of the session sidebar in a view mode for the Settings picker; sizes are fixed px on purpose so it ignores the padding scale. */
export const SidebarViewPreview: React.FC<{ mode: SidebarViewMode }> = ({ mode }) => {
  return (
    <div data-sidebar-view-preview={mode} className="flex h-full w-full bg-background">
      <div className="flex w-[58%] shrink-0 flex-col gap-[4px] overflow-hidden border-r border-border bg-sidebar p-[6px]">
        {mode === 'workspace' && (
          <>
            <FolderRow width="w-[55%]" selected />
            <FolderRow width="w-[70%]" />
            <FolderRow width="w-[45%]" />
            <div className="h-px shrink-0 bg-border" />
            <CardRow title="w-[75%]" details="w-[50%]" selected />
            <CardRow title="w-[60%]" details="w-[40%]" />
          </>
        )}
        {mode === 'folder' && (
          <>
            <FolderRow width="w-[60%]" chevron />
            <TreeRow width="w-[70%]" selected />
            <TreeRow width="w-[55%]" />
            <FolderRow width="w-[45%]" chevron />
            <TreeRow width="w-[65%]" />
            <FolderRow width="w-[55%]" chevron />
          </>
        )}
        {mode === 'timeline' && (
          <>
            <div className="mx-[3px] h-[2px] w-[28%] shrink-0 rounded-full bg-foreground/35" />
            <CardRow title="w-[75%]" details="w-[50%]" selected />
            <CardRow title="w-[60%]" details="w-[45%]" />
            <div className="mx-[3px] h-[2px] w-[36%] shrink-0 rounded-full bg-foreground/35" />
            <CardRow title="w-[70%]" details="w-[40%]" />
          </>
        )}
      </div>
      <div className="flex min-w-[0px] flex-1 flex-col gap-[4px] p-[6px]">
        <div className="h-[3px] w-[80%] rounded-full bg-foreground/10" />
        <div className="h-[3px] w-[55%] rounded-full bg-foreground/10" />
        <div className="mt-auto h-[10px] rounded-[3px] border border-border" />
      </div>
    </div>
  );
};
