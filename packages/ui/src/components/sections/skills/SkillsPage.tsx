import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ProjectTrustDialog } from '@/components/sections/shared/ProjectTrustDialog';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { SkillCard, SkillCardSkeleton } from '@/components/sections/skills/SkillCard';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { SnippetMarkdownEditor } from '@/components/sections/snippets/SnippetMarkdownEditor';

/** Pi-native skill discovery — grid browse + detail with markdown and inline editing when Pi marks the skill editable. */
export const SkillsPage: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const selectedSkillName = useSkillsStore((state) => state.selectedSkillName);
  const setSelectedSkill = useSkillsStore((state) => state.setSelectedSkill);
  const skills = useSkillsStore((state) => state.skills);
  const isLoading = useSkillsStore((state) => state.isLoading);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const [skillQuery, setSkillQuery] = React.useState('');
  const [locationFilter, setLocationFilter] = React.useState<'all' | 'project' | 'global'>('all');
  const [refreshing, setRefreshing] = React.useState(false);

  const skill = React.useMemo(
    () => skills.find((item) => item.name === selectedSkillName) ?? null,
    [skills, selectedSkillName],
  );
  const updateSkillContent = useSkillsStore((state) => state.updateSkillContent);
  const [isEditingSkill, setIsEditingSkill] = React.useState(false);
  const [skillDraft, setSkillDraft] = React.useState('');
  const [isSavingSkill, setIsSavingSkill] = React.useState(false);

  React.useEffect(() => {
    if (skill) {
      setSkillDraft(skill.content ?? '');
      setIsEditingSkill(false);
    } else {
      setIsEditingSkill(false);
    }
  }, [skill?.id, skill?.content]);

  const refreshSkills = React.useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { invalidateSkillsLoadCache } = await import('@/stores/useSkillsStore');
      invalidateSkillsLoadCache();
      await loadSkills();
    } finally {
      setRefreshing(false);
    }
  }, [loadSkills, refreshing]);

  React.useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const sortedSkills = React.useMemo(() => {
    return [...skills].sort((a, b) => {
      if (a.location !== b.location) {
        if (a.location === 'project') return -1;
        if (b.location === 'project') return 1;
        if (a.location === 'global') return -1;
        if (b.location === 'global') return 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [skills]);

  const filteredSkills = React.useMemo(() => {
    let list = sortedSkills;
    if (locationFilter !== 'all') {
      list = list.filter((s) => s.location === locationFilter);
    }
    const q = skillQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => {
      const name = s.name.toLowerCase();
      const desc = (s.description ?? '').toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [sortedSkills, locationFilter, skillQuery]);

  const locationCounts = React.useMemo(() => {
    let project = 0;
    let global = 0;
    for (const s of skills) {
      if (s.location === 'project') project += 1;
      else if (s.location === 'global') global += 1;
    }
    return { all: skills.length, project, global };
  }, [skills]);

  // Detail view for selected skill
  if (skill) {
    const locationLabel = skill.location === 'project' ? 'Project' : skill.location === 'global' ? 'Global' : skill.location;
    const hasContent = typeof skill.content === 'string' && skill.content.trim().length > 0;
    const isEditable = skill.editable === true;
    const isDirty = skillDraft !== (skill.content ?? '');

    const handleSaveSkill = async () => {
      if (!isEditable || isSavingSkill) return;
      setIsSavingSkill(true);
      const ok = await updateSkillContent(skill.name, skillDraft);
      setIsSavingSkill(false);
      if (ok) {
        toast.success("Skill saved");
        setIsEditingSkill(false);
      } else {
        toast.error("Failed to save skill");
      }
    };

    const handleCancelSkillEdit = () => {
      setSkillDraft(skill.content ?? '');
      setIsEditingSkill(false);
    };

    return (
      <>
        <ProjectTrustDialog onResolved={() => void loadSkills()} />
        <SettingsPageLayout
          title={
            <span className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setSelectedSkill(null)}
                aria-label="Back to skills"
                className="-ml-1 h-7 w-7 p-0"
              >
                <Icon name="arrow-left-s" className="size-4" />
              </Button>
              <span className="truncate">{skill.name}</span>
            </span>
          }
          description={skill.description ? <span className="typography-settings-description text-muted-foreground">{skill.description}</span> : undefined}
          headerEnd={
            isEditable && !isEditingSkill ? (
              <Button variant="outline" size="xs" onClick={() => setIsEditingSkill(true)}>
                <Icon name="edit" className="size-3.5" />
                Edit
              </Button>
            ) : undefined
          }
        >
          <SettingsSection title="Details" divider={false} settingsItem="skills.discovery">
            <div className="flex flex-wrap gap-2 typography-micro">
              <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 font-medium capitalize text-muted-foreground">{locationLabel}</span>
              {isEditable ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-success)]/10 px-2.5 py-1 font-medium text-[var(--status-success)]">
                  <Icon name="check" className="size-3.5" aria-hidden />
                  Editable
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-muted-foreground/60" aria-hidden />
                  Read-only
                </span>
              )}
            </div>
            {!isEditable ? (
              <p className="typography-micro text-muted-foreground">This skill is provided by a package or template and cannot be edited. Create a new skill in your project to customize it.</p>
            ) : null}
          </SettingsSection>

          <SettingsSection
            title="Skill Guide"
            settingsItem="skills.content"
            info={isEditingSkill ? "Markdown supported. Preview your changes before saving." : "Rendered from the SKILL.md markdown file discovered by Pi."}
            headerAction={
              isEditable && isEditingSkill ? (
                <span className="typography-micro text-muted-foreground">{isDirty ? "Unsaved changes" : "No changes"}</span>
              ) : undefined
            }
          >
            {isEditingSkill ? (
              <>
                <SnippetMarkdownEditor
                  value={skillDraft}
                  onChange={setSkillDraft}
                  placeholder="Write the skill guide in markdown..."
                  hideExpandsNote
                  minHeight={360}
                />
                <div className="flex items-center justify-between gap-2 pt-3">
                  <Button variant="ghost" size="xs" onClick={handleCancelSkillEdit} disabled={isSavingSkill}>
                    Cancel
                  </Button>
                  <Button size="xs" onClick={() => void handleSaveSkill()} disabled={isSavingSkill || !isDirty}>
                    {isSavingSkill ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </>
            ) : hasContent ? (
              <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4 @xl:p-6">
                <SimpleMarkdownRenderer content={skill.content ?? ''} stripFrontmatter className="max-w-none" />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-10 text-center">
                <Icon name="book-open" className="size-6 text-muted-foreground/60" aria-hidden />
                <p className="typography-meta text-muted-foreground">No guide content available for this skill.</p>
                <p className="typography-micro text-muted-foreground">The daemon did not return markdown for this resource.</p>
                {isEditable ? (
                  <Button variant="outline" size="xs" onClick={() => setIsEditingSkill(true)} className="mt-2">
                    <Icon name="edit" className="size-3.5" />
                    Add content
                  </Button>
                ) : null}
              </div>
            )}
            {isEditable && !isEditingSkill && hasContent ? (
              <div className="flex justify-end pt-3">
                <Button variant="outline" size="xs" onClick={() => setIsEditingSkill(true)}>
                  <Icon name="edit" className="size-3.5" />
                  Edit
                </Button>
              </div>
            ) : null}
          </SettingsSection>
        </SettingsPageLayout>
      </>
    );
  }

  // Grid browse view (no skill selected)

  // Loading skeleton (initial load, no skills yet)
  if (isLoading && skills.length === 0) {
    return (
      <>
        <ProjectTrustDialog onResolved={() => void loadSkills()} />
        <SettingsPageLayout
          title={isMobile ? undefined : 'Skills'}
          description={isMobile ? undefined : 'Browse skills discovered by Pi. Click a card to read its guide.'}
          headerEnd={
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void refreshSkills()}
                disabled={refreshing}
                aria-label="Refresh skills"
                title="Refresh skills"
              >
                <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
              </Button>
            </div>
          }
        >
          <SettingsSection title="Skills" divider={false} settingsItem="skills.discovery">
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
              <SkillCardSkeleton count={6} />
            </div>
          </SettingsSection>
        </SettingsPageLayout>
      </>
    );
  }

  // Empty state (no skills after load)
  if (filteredSkills.length === 0 && skillQuery.trim() === '' && skills.length === 0) {
    return (
      <>
        <ProjectTrustDialog onResolved={() => void loadSkills()} />
        <SettingsPageLayout
          title={isMobile ? undefined : 'Skills'}
          description={isMobile ? undefined : 'Browse skills discovered by Pi. Click a card to read its guide.'}
          headerEnd={
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Icon
                  name="search"
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  placeholder="Search skills"
                  aria-label="Search skills"
                  className="h-9 w-[18rem] max-w-[24rem] pl-8"
                />
                {skillQuery ? (
                  <button
                    type="button"
                    onClick={() => setSkillQuery('')}
                    aria-label="Clear search"
                    className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void refreshSkills()}
                disabled={refreshing}
                aria-label="Refresh skills"
                title="Refresh skills"
              >
                <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
              </Button>
            </div>
          }
        >
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Icon name="book-open" className="size-8 text-muted-foreground/60" aria-hidden />
            <p className="typography-meta text-muted-foreground">No skills configured</p>
            <p className="typography-micro text-muted-foreground">Skills appear here when Pi discovers SKILL.md files.</p>
          </div>
        </SettingsPageLayout>
      </>
    );
  }

  // Main grid
  return (
    <>
      <ProjectTrustDialog onResolved={() => void loadSkills()} />
      <SettingsPageLayout
        title={isMobile ? undefined : 'Skills'}
        description={isMobile ? undefined : 'Browse skills discovered by Pi. Click a card to read its guide.'}
        headerEnd={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder="Search skills"
                aria-label="Search skills"
                className="h-9 w-[18rem] max-w-[24rem] pl-8"
              />
              {skillQuery ? (
                <button
                  type="button"
                  onClick={() => setSkillQuery('')}
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                >
                  <Icon name="close" className="size-4" />
                </button>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refreshSkills()}
              disabled={refreshing}
              aria-label="Refresh skills"
              title="Refresh skills"
            >
              <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
            </Button>
          </div>
        }
      >
        <SettingsSection title="Skills" divider={false} settingsItem="skills.discovery">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Button
              variant="chip"
              size="xs"
              aria-pressed={locationFilter === 'all'}
              onClick={() => setLocationFilter('all')}
            >
              All {locationCounts.all}
            </Button>
            <Button
              variant="chip"
              size="xs"
              aria-pressed={locationFilter === 'project'}
              onClick={() => setLocationFilter('project')}
            >
              Project {locationCounts.project}
            </Button>
            <Button
              variant="chip"
              size="xs"
              aria-pressed={locationFilter === 'global'}
              onClick={() => setLocationFilter('global')}
            >
              Global {locationCounts.global}
            </Button>
          </div>
          {filteredSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <p className="typography-meta text-muted-foreground">
                {skillQuery.trim() ? `No skills match “${skillQuery}”.` : `No ${locationFilter} skills.`}
              </p>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setSkillQuery('');
                  setLocationFilter('all');
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
              {filteredSkills.map((s) => (
                <SkillCard key={s.id} skill={s} onSelect={setSelectedSkill} showLocationPill={locationFilter === 'all'} />
              ))}
            </div>
          )}
        </SettingsSection>
      </SettingsPageLayout>
    </>
  );
};
