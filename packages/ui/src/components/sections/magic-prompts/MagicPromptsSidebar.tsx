import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useMagicPromptsStore } from '@/stores/useMagicPromptsStore';
import { cn } from '@/lib/utils';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';

interface MagicPromptsSidebarProps {
  onItemSelect?: () => void;
}

export const MagicPromptsSidebar: React.FC<MagicPromptsSidebarProps> = ({ onItemSelect }) => {
  const selectedPromptId = useMagicPromptsStore((state) => state.selectedPromptId);
  const setSelectedPromptId = useMagicPromptsStore((state) => state.setSelectedPromptId);

  const grouped = React.useMemo(() => {
    return [
      {
        groupLabel: "Git",
        items: [
          { id: 'git.commit.generate', title: "Commit Generation" },
          { id: 'git.pr.generate', title: "PR Generation" },
          { id: 'git.conflict.resolve', title: "Merge/Rebase Conflict Resolution" },
          { id: 'git.integrate.cherrypick.resolve', title: "Cherry-pick Conflict Resolution" },
        ],
      },
      {
        groupLabel: "GitHub",
        items: [
          { id: 'github.pr.review', title: "PR Review" },
          { id: 'github.issue.review', title: "Issue Review" },
          { id: 'github.pr.checks.review', title: "PR Failed Checks Review" },
          { id: 'github.pr.comments.review', title: "PR Comments Review" },
          { id: 'github.pr.comment.single', title: "Single PR Comment Review" },
        ],
      },
      {
        groupLabel: "Planning",
        items: [
          { id: 'plan.todo', title: "Todo Planning" },
          { id: 'plan.improve', title: "Improve Plan" },
          { id: 'plan.implement', title: "Implement Plan" },
        ],
      },
      {
        groupLabel: "Session",
        items: [
          { id: 'session.explore', title: "Codebase Tour" },
          { id: 'session.summary', title: "Session Summary" },
          { id: 'session.plan', title: "Feature Planning" },
          { id: 'session.catchup', title: "Catch Up" },
          { id: 'session.debug', title: "Debugging" },
          { id: 'session.weigh', title: "Weigh Options" },
          { id: 'session.fusion', title: "Fusion" },
        ],
      },
    ] as const;
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className={SETTINGS_PANEL_TITLE_CLASS}>{"PiChamber Utility Prompts"}</h2>
        <p className="typography-meta mt-1 text-muted-foreground">{"Select a prompt template to edit."}</p>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-3 px-3 py-2 overflow-x-hidden">
        {grouped.map((group) => (
          <div key={group.groupLabel} className="space-y-1">
            <div className="typography-micro px-1 text-muted-foreground">{group.groupLabel}</div>
            {group.items.map((item) => {
              const selected = selectedPromptId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedPromptId(item.id);
                    onItemSelect?.();
                  }}
                  className={cn(
                    'flex w-full items-center rounded-md px-2 py-1.5 text-left transition-colors',
                    selected ? 'bg-interactive-selection text-foreground' : 'text-foreground hover:bg-interactive-hover'
                  )}
                >
                  <span className="typography-ui-label truncate font-normal">{item.title}</span>
                </button>
              );
            })}
          </div>
        ))}
      </ScrollableOverlay>
    </div>
  );
};
