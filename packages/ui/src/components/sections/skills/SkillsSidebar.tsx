import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { cn } from '@/lib/utils';

interface SkillsSidebarProps {
  onItemSelect?: () => void;
}

/** Pi-discovered skills are intentionally browse-only; package/install mutation is not a core migration feature. */
export const SkillsSidebar: React.FC<SkillsSidebarProps> = ({ onItemSelect }) => {
  
  const skills = useSkillsStore((state) => state.skills);
  const selectedSkillName = useSkillsStore((state) => state.selectedSkillName);
  const setSelectedSkill = useSkillsStore((state) => state.setSelectedSkill);
  const sorted = React.useMemo(() => [...skills].sort((left, right) => left.name.localeCompare(right.name)), [skills]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-3 pb-3 pt-4">
        <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{"Skills"}</h2>
        <span className="typography-meta text-muted-foreground">{`Total ${skills.length}`}</span>
      </div>
      <ScrollableOverlay outerClassName="min-h-0 flex-1" className="space-y-1 px-3 py-2">
        {sorted.length === 0 ? (
          <div className="px-4 py-12 text-center text-muted-foreground">
            <Icon name="book-open" className="mx-auto mb-3 size-10 opacity-50" />
            <p className="typography-ui-label">{"No skills configured"}</p>
            <p className="typography-meta mt-1">{"Use the + button above to create one"}</p>
          </div>
        ) : sorted.map((skill) => (
          <button
            key={skill.id}
            type="button"
            onClick={() => { setSelectedSkill(skill.name); onItemSelect?.(); }}
            className={cn(
              'flex w-full flex-col rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              selectedSkillName === skill.name ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
            )}
          >
            <span className="typography-ui-label truncate text-foreground">{skill.name}</span>
            {skill.description ? <span className="typography-micro truncate text-muted-foreground">{skill.description}</span> : null}
          </button>
        ))}
      </ScrollableOverlay>
    </div>
  );
};
