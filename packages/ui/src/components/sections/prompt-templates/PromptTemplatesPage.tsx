import React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsSection,
  SETTINGS_SELECT_SIZE,
} from "@/components/sections/shared/SettingsSection";
import { SettingsPageLayout } from "@/components/sections/shared/SettingsPageLayout";
import { Icon } from "@/components/icon/Icon";
import { cn } from "@/lib/utils";
import { useDeviceInfo } from "@/lib/device";
import {
  invalidatePromptTemplatesLoadCache,
  usePromptTemplatesStore,
  type PromptTemplate,
  type PromptTemplateScopeFilter,
} from "@/stores/usePromptTemplatesStore";
import { useEffectiveDirectory } from "@/hooks/useEffectiveDirectory";
import { useUIStore } from "@/stores/useUIStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { updateDesktopSettings } from "@/lib/persistence";
import { busySettingsMessage, deferredSettingsMessage } from "@/lib/pi/mutation-status";
import {
  getProjectDraftStarters,
  saveProjectDraftStarters,
} from "@/lib/pichamberConfig";
import { promptVariableChips } from "./promptVariables";
import { SnippetCardSkeleton } from "@/components/sections/snippets/SnippetCard";
import { SnippetMarkdownEditor } from "@/components/sections/snippets/SnippetMarkdownEditor";
import { SimpleMarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const updatePinnedPromptReference = async ({
  previousName,
  nextName,
  previousLocation,
  nextLocation,
}: {
  previousName: string;
  nextName: string;
  previousLocation: PromptTemplateScopeFilter;
  nextLocation: PromptTemplateScopeFilter;
}): Promise<boolean> => {
  const projectsState = useProjectsStore.getState();
  const activeProject = projectsState.projects.find(
    (project) => project.id === projectsState.activeProjectId,
  );
  const projectRef = activeProject?.path
    ? { id: activeProject.id, path: activeProject.path }
    : null;
  const globalStarters = useUIStore.getState().globalDraftStarters ?? [];
  const projectStarters = projectRef
    ? await getProjectDraftStarters(projectRef)
    : [];
  const source = previousLocation === "project" ? projectStarters : globalStarters;
  const wasPinned = source.some(
    (starter) => starter.type === "prompt" && starter.name === previousName,
  );
  if (!wasPinned) return true;
  if (nextLocation === "project" && !projectRef) return false;

  const removePrevious = (starters: typeof globalStarters) =>
    starters.filter(
      (starter) => !(starter.type === "prompt" && starter.name === previousName),
    );
  let nextGlobal = previousLocation === "global"
    ? removePrevious(globalStarters)
    : globalStarters;
  let nextProject = previousLocation === "project"
    ? removePrevious(projectStarters)
    : projectStarters;
  const replacement = {
    type: "prompt" as const,
    name: nextName,
    scope: nextLocation,
  };
  if (nextLocation === "project") {
    if (!nextProject.some((starter) => starter.type === "prompt" && starter.name === nextName)) {
      nextProject = [...nextProject, replacement];
    }
  } else if (!nextGlobal.some((starter) => starter.type === "prompt" && starter.name === nextName)) {
    nextGlobal = [...nextGlobal, replacement];
  }

  if (JSON.stringify(nextGlobal) !== JSON.stringify(globalStarters)) {
    useUIStore.getState().setGlobalDraftStarters(nextGlobal);
    await updateDesktopSettings({ draftStarters: nextGlobal });
  }
  if (projectRef && JSON.stringify(nextProject) !== JSON.stringify(projectStarters)) {
    return saveProjectDraftStarters(projectRef, nextProject);
  }
  return true;
};

/** Pi-owned prompt templates. Pi expands their native `/name` commands. */
export const PromptTemplatesPage: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const { t } = useTranslation();
  const effectiveDirectory = useEffectiveDirectory();
  const selectedId = usePromptTemplatesStore((s) => s.selectedPromptId);
  const draft = usePromptTemplatesStore((s) => s.promptDraft);
  const prompts = usePromptTemplatesStore((s) => s.prompts);
  const isLoading = usePromptTemplatesStore((s) => s.isLoading);
  const setSelectedPrompt = usePromptTemplatesStore((s) => s.setSelectedPrompt);
  const setPromptDraft = usePromptTemplatesStore((s) => s.setPromptDraft);
  const createPrompt = usePromptTemplatesStore((s) => s.createPrompt);
  const updatePrompt = usePromptTemplatesStore((s) => s.updatePrompt);
  const deletePrompt = usePromptTemplatesStore((s) => s.deletePrompt);
  const loadPrompts = usePromptTemplatesStore((s) => s.loadPrompts);

  const selected = React.useMemo(
    () => (selectedId ? (prompts.find((p) => p.id === selectedId) ?? null) : null),
    [prompts, selectedId],
  );
  const isNew = Boolean(draft && !selected);
  const isEditable = isNew || selected?.editable === true;
  const isReadOnly = !isNew && selected && selected.editable !== true;

  const [name, setName] = React.useState("");
  const [location, setLocation] = React.useState<PromptTemplateScopeFilter>("global");
  const [description, setDescription] = React.useState("");
  const [content, setContent] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = React.useState(false);
  const originalName = React.useRef("");
  const originalDescription = React.useRef("");
  const originalContent = React.useRef("");
  const originalLocation = React.useRef<PromptTemplateScopeFilter>("global");

  React.useEffect(() => {
    if (isNew && draft) {
      setName(draft.name);
      setLocation(draft.location);
      setDescription(draft.description ?? "");
      setContent(draft.content ?? "");
      originalName.current = draft.name;
      originalDescription.current = draft.description ?? "";
      originalContent.current = draft.content ?? "";
      originalLocation.current = draft.location;
    } else if (selected) {
      setName(selected.name);
      setLocation(
        selected.location === "project" ? "project" : "global",
      );
      setDescription(selected.description ?? "");
      setContent(selected.content ?? "");
      originalName.current = selected.name;
      originalDescription.current = selected.description ?? "";
      originalContent.current = selected.content ?? "";
      originalLocation.current = selected.location === "project" ? "project" : "global";
    }
  }, [draft, isNew, selected]);

  const handleBack = React.useCallback(() => {
    if (isNew) setPromptDraft(null);
    setSelectedPrompt(null);
  }, [isNew, setPromptDraft, setSelectedPrompt]);

  const handleSaveNew = React.useCallback(async () => {
    const normalizedName = name.trim().replace(/\s+/g, "-");
    if (!normalizedName) {
      toast.error(t('Prompt name is required'));
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(normalizedName)) {
      toast.error(t('Prompt name may only contain letters, numbers, dashes and underscores'));
      return;
    }
    if (!content.trim()) {
      toast.error(t('Prompt content is required'));
      return;
    }
    if (location === "project" && !effectiveDirectory?.trim()) {
      toast.error(t('Project prompts need an active project directory'));
      return;
    }
    setSaving(true);
    const success = await createPrompt(normalizedName, content, {
      description,
      location,
      directory: effectiveDirectory,
    });
    setSaving(false);
    if (success === 'busy') {
      toast.info(busySettingsMessage(`Prompt /${normalizedName}`));
    } else if (success === 'deferred') {
      toast.info(deferredSettingsMessage(`Prompt /${normalizedName}`));
    } else if (success) {
      toast.success(t('Prompt /{{name}} created', { name: normalizedName }));
    } else {
      toast.error(t('Failed to create prompt template'));
    }
  }, [content, createPrompt, description, effectiveDirectory, location, name, t]);

  const handleSaveEdit = React.useCallback(async () => {
    if (!selected) return;
    const normalizedName = name.trim().replace(/\s+/g, "-");
    if (!normalizedName) {
      toast.error(t('Prompt name is required'));
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(normalizedName)) {
      toast.error(t('Prompt name may only contain letters, numbers, dashes and underscores'));
      return;
    }
    if (!content.trim()) {
      toast.error(t('Prompt content is required'));
      return;
    }
    if (location === "project" && !effectiveDirectory?.trim()) {
      toast.error(t('Project prompts need an active project directory'));
      return;
    }
    setSaving(true);
    const previousName = originalName.current;
    const previousLocation = originalLocation.current;
    const success = await updatePrompt(
      selected.id,
      {
        ...(normalizedName !== originalName.current ? { name: normalizedName } : {}),
        ...(description !== originalDescription.current ? { description } : {}),
        ...(content !== originalContent.current ? { content } : {}),
        ...(location !== originalLocation.current ? { location } : {}),
      },
      effectiveDirectory,
    );
    setSaving(false);
    if (success === 'busy') {
      toast.info(busySettingsMessage(`Prompt /${normalizedName}`));
    } else if (success) {
      let startersUpdated = true;
      if (
        previousName &&
        (normalizedName !== previousName || location !== previousLocation)
      ) {
        try {
          startersUpdated = await updatePinnedPromptReference({
            previousName,
            nextName: normalizedName,
            previousLocation,
            nextLocation: location,
          });
        } catch {
          startersUpdated = false;
        }
      }
      if (success === 'deferred') {
        toast.info(deferredSettingsMessage(`Prompt /${normalizedName}`));
      } else {
        toast.success(t('Prompt /{{name}} updated', { name: normalizedName }));
      }
      if (!startersUpdated) {
        toast.warning(t('The prompt was updated, but one or more pinned starters could not be updated.'));
      }
    } else {
      toast.error(t('Failed to update prompt template'));
    }
  }, [content, description, effectiveDirectory, location, name, selected, t, updatePrompt]);

  const handleDelete = React.useCallback(async () => {
    if (!selected) return;
    setDeleting(true);
    const success = await deletePrompt(selected.id, effectiveDirectory);
    setDeleting(false);
    if (success === 'busy') {
      toast.info(busySettingsMessage('Prompt template'));
    } else if (success === 'deferred') {
      toast.info(deferredSettingsMessage('Prompt template'));
      setConfirmDeleteOpen(false);
    } else if (success) {
      toast.success(t('Prompt template deleted'));
      setConfirmDeleteOpen(false);
    } else {
      toast.error(t('Failed to delete prompt template'));
    }
  }, [deletePrompt, effectiveDirectory, selected, t]);

  const [promptQuery, setPromptQuery] = React.useState("");
  const [locationFilter, setLocationFilter] = React.useState<"all" | "global" | "project">("all");
  const [refreshing, setRefreshing] = React.useState(false);

  const refreshPrompts = React.useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      invalidatePromptTemplatesLoadCache(effectiveDirectory);
      await loadPrompts(effectiveDirectory);
    } finally {
      setRefreshing(false);
    }
  }, [effectiveDirectory, loadPrompts, refreshing]);

  React.useEffect(() => {
    void loadPrompts(effectiveDirectory);
  }, [effectiveDirectory, loadPrompts]);

  const sortedPrompts: PromptTemplate[] = React.useMemo(
    () => [...prompts].sort((a, b) => a.name.localeCompare(b.name)),
    [prompts],
  );

  const filteredPrompts = React.useMemo(() => {
    let list = sortedPrompts;
    if (locationFilter !== "all") {
      list = list.filter((p) => p.location === locationFilter);
    }
    const q = promptQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => {
      return (
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        (p.content ?? "").toLowerCase().includes(q)
      );
    });
  }, [locationFilter, promptQuery, sortedPrompts]);

  const locationCounts = React.useMemo(() => {
    let global = 0;
    let project = 0;
    for (const p of prompts) {
      if (p.location === "project") project += 1;
      else if (p.location === "global") global += 1;
    }
    return { all: prompts.length, global, project };
  }, [prompts]);

  const variableChips = React.useMemo(() => promptVariableChips(content), [content]);

  const handleCreateNew = React.useCallback(() => {
    const existing = new Set(prompts.map((p) => p.name.toLowerCase()));
    let newName = "new-prompt";
    let counter = 1;
    while (existing.has(newName.toLowerCase())) {
      newName = `new-prompt-${counter++}`;
    }
    setPromptDraft({ name: newName, location: "global" });
    setSelectedPrompt(null);
  }, [prompts, setPromptDraft, setSelectedPrompt]);

  if (selectedId !== null || draft) {
    if (!selected && !isNew) {
      return (
        <SettingsPageLayout
          title={
            <span className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={handleBack}
                aria-label={t('Back to prompt templates')}
                className="-ml-1 h-7 w-7 p-0"
              >
                <Icon name="arrow-left-s" className="size-4" />
              </Button>
              <span className="truncate">{t('Not found')}</span>
            </span>
          }
          description={t('This prompt template no longer exists.')}
        >
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Icon name="terminal" className="size-8 text-muted-foreground/60" aria-hidden />
            <p className="typography-meta text-muted-foreground">
              {t('The selected prompt template was not found.')}
            </p>
            <Button variant="outline" size="sm" onClick={handleBack}>
              {t('Back to prompt templates')}
            </Button>
          </div>
        </SettingsPageLayout>
      );
    }

    const locationLabel =
      selected?.location === "project"
        ? t('Project')
        : selected?.location === "global"
          ? t('Global')
          : (selected?.location ?? t('Global'));
    const normalizedDraftName = name.trim().replace(/\s+/g, "-");
    const isDirty =
      normalizedDraftName !== originalName.current ||
      description !== originalDescription.current ||
      content !== originalContent.current ||
      location !== originalLocation.current;
    const canSave =
      isDirty && !saving && content.trim().length > 0 && name.trim().length > 0;

    return (
      <>
        <SettingsPageLayout
          title={
            <span className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={handleBack}
                aria-label={t('Back to prompt templates')}
                className="-ml-1 h-7 w-7 p-0"
              >
                <Icon name="arrow-left-s" className="size-4" />
              </Button>
              <span className="truncate">
                {isNew ? t('New prompt template') : `/${selected?.name ?? name}`}
              </span>
            </span>
          }
          description={
            isNew ? (
              <span className="typography-settings-description text-muted-foreground">
                {t('Create a native Pi command')}
              </span>
            ) : selected?.description ? (
              <span className="typography-settings-description text-muted-foreground">
                {selected.description}
              </span>
            ) : undefined
          }
          headerEnd={
            !isNew && selected?.editable === true ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setConfirmDeleteOpen(true)}
                className="text-destructive hover:text-destructive"
              >
                <Icon name="delete-bin" className="size-4" />
                {t('Delete')}
              </Button>
            ) : null
          }
        >
          {isNew ? (
            <SettingsSection title={t('Identity')} divider={false} settingsItem="prompt-templates.create">
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="typography-settings-field-label text-foreground">{t('Name')}</label>
                    <div className="flex items-center gap-2">
                      <span className="typography-ui-label text-muted-foreground">/</span>
                      <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="review"
                        className="h-9 flex-1 font-mono"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </div>
                    <p className="typography-micro text-muted-foreground">
                      {t('Used as')}{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                        /{name.trim() || "name"}
                      </code>{" "}
                      {t('in chat. Letters, numbers, dashes and underscores only.')}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="typography-settings-field-label text-foreground">{t('Scope')}</label>
                    <Select value={location} onValueChange={(v) => setLocation(v as PromptTemplateScopeFilter)}>
                      <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="global">{t('Global')}</SelectItem>
                        <SelectItem value="project">{t('Project')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="typography-micro text-muted-foreground">
                      {location === "project"
                        ? t('Available only in this trusted project.')
                        : t('Available in every project.')}
                    </p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="typography-settings-field-label text-foreground">{t('Description')}</label>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('What does this command do?')}
                    className="h-9 w-full"
                  />
                </div>
              </div>
            </SettingsSection>
          ) : (
            <SettingsSection title={t('Details')} divider={false} settingsItem="prompt-templates.create">
              <div className="flex flex-wrap gap-2 typography-micro">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2.5 py-1 font-medium capitalize",
                    selected?.location === "project"
                      ? "bg-[var(--primary-base)]/10 text-[var(--primary-base)]"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {locationLabel}
                </span>
                {selected?.editable === true ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-success)]/10 px-2.5 py-1 font-medium text-[var(--status-success)]">
                    <Icon name="check" className="size-3.5" aria-hidden />
                    {t('Editable')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">
                    {t('Read-only')}
                  </span>
                )}
              </div>
              {isReadOnly ? (
                <p className="typography-micro pt-3 text-muted-foreground">
                  {t('This prompt was discovered from a package or path and cannot be edited.')}
                </p>
              ) : null}
              {selected?.location === "project" ? (
                <p className="typography-micro pt-2 text-muted-foreground">
                  {t('Project prompts require a trusted project. Untrusted projects cannot create or edit them.')}
                </p>
              ) : null}
              {isEditable ? (
                <div className="space-y-1.5 pt-4">
                  <label className="typography-settings-field-label text-foreground">{t('Scope')}</label>
                  <Select value={location} onValueChange={(value) => setLocation(value as PromptTemplateScopeFilter)}>
                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full" aria-label={t('Prompt template scope')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">{t('Global')}</SelectItem>
                      <SelectItem value="project">{t('Project')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="typography-micro text-muted-foreground">
                    {location === "project"
                      ? t('Available only in this trusted project.')
                      : t('Available in every project.')}
                  </p>
                </div>
              ) : null}
              {isEditable ? (
                <div className="space-y-1.5 pt-4">
                  <label className="typography-settings-field-label text-foreground">{t('Name')}</label>
                  <div className="flex items-center gap-2">
                    <span className="typography-ui-label text-muted-foreground">/</span>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="h-9 flex-1 font-mono"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                  <p className="typography-micro text-muted-foreground">
                    {t('Used as')}{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                      /{name.trim() || "name"}
                    </code>{" "}
                    {t('in chat. Letters, numbers, dashes and underscores only.')}
                  </p>
                </div>
              ) : null}
              {isEditable ? (
                <div className="space-y-1.5 pt-3">
                  <label className="typography-settings-field-label text-foreground">{t('Description')}</label>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="h-9 w-full"
                  />
                </div>
              ) : null}
            </SettingsSection>
          )}

          <SettingsSection
            title={t('Arguments')}
            info={t('Pi expands prompt arguments natively. PiChamber only inserts the /name command.')}
          >
            <ul className="typography-micro list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">$1</code>,{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">$2</code> — {t('positional arguments')}
              </li>
              <li>
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">$@</code> — {t('all arguments')}
              </li>
              <li>
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{"${1:-default}"}</code> — {t('defaults when an argument is missing')}
              </li>
              <li>
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{"${@:2}"}</code> — {t('slices such as arguments from position 2 onward')}
              </li>
            </ul>
            <p className="typography-micro pt-2 text-muted-foreground">
              {t('Example:')} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">/review auth tests</code> {t('supplies arguments that Pi substitutes into the template.')}
            </p>
          </SettingsSection>

          <SettingsSection
            title={t('Content')}
            divider
            settingsItem="prompt-templates.content"
            info={t('Prompt content supports Pi argument syntax such as $1 and $@. Pi expands it when the / command runs.')}
            headerAction={
              isEditable ? (
                <span className="typography-micro text-muted-foreground">
                  {isDirty ? t('Unsaved changes') : t('No changes')}
                </span>
              ) : undefined
            }
          >
            {isEditable ? (
              <>
                <SnippetMarkdownEditor
                  key={isNew ? "new-prompt-editor" : `prompt-editor:${selected?.id ?? ""}`}
                  value={content}
                  onChange={setContent}
                  initialMode={isNew ? "write" : "preview"}
                  contentLabel={t('Prompt content')}
                  placeholder={t('Enter prompt content... Use markdown and Pi argument syntax such as $1 and $@.')}
                  triggerPreview={`/${name.trim() || "name"}`}
                  triggerActionLabel={t('Runs as')}
                  variableChips={variableChips}
                />
                <div className="flex items-center justify-between gap-3 pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (isNew) handleBack();
                      else {
                        setName(originalName.current);
                        setLocation(originalLocation.current);
                        setDescription(originalDescription.current);
                        setContent(originalContent.current);
                      }
                    }}
                  >
                    {t('Cancel')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void (isNew ? handleSaveNew() : handleSaveEdit())}
                    disabled={!canSave}
                  >
                    {saving ? t('Saving…') : isNew ? t('Create prompt') : t('Save changes')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {(selected?.content ?? "").trim() ? (
                  <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4 @xl:p-6">
                    <SimpleMarkdownRenderer content={selected?.content ?? ""} stripFrontmatter className="max-w-none" />
                  </div>
                ) : (
                  <p className="typography-micro text-muted-foreground">{t('No content.')}</p>
                )}
              </>
            )}
          </SettingsSection>

          {!isNew && selected?.editable === true ? (
            <SettingsSection title={t('Danger zone')} divider>
              <div className="flex items-center justify-between gap-4 rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-3">
                <div className="min-w-0">
                  <div className="typography-ui-label font-medium text-foreground">{t('Delete prompt')}</div>
                  <div className="typography-micro text-muted-foreground">
                    {t('Permanently remove /{{name}}. This cannot be undone.', { name: selected.name })}
                  </div>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setConfirmDeleteOpen(true)} disabled={deleting}>
                  <Icon name="delete-bin" className="size-4" />
                  {t('Delete')}
                </Button>
              </div>
            </SettingsSection>
          ) : null}
        </SettingsPageLayout>

        <Dialog open={confirmDeleteOpen} onOpenChange={(open) => !open && setConfirmDeleteOpen(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('Delete prompt?')}</DialogTitle>
              <DialogDescription>
                {t('This will permanently delete /{{name}}. This cannot be undone.', { name: selected?.name ?? "" })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteOpen(false)} disabled={deleting}>
                {t('Cancel')}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={deleting}>
                {deleting ? t('Deleting…') : t('Delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  if (isLoading && prompts.length === 0) {
    return (
      <SettingsPageLayout
        title={isMobile ? undefined : t('Prompt templates')}
        description={isMobile ? undefined : t('Native Pi commands that run as /name.')}
        headerEnd={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refreshPrompts()}
              disabled={refreshing}
              aria-label={t('Refresh prompt templates')}
              title={t('Refresh prompt templates')}
            >
              <Icon name="refresh" className={cn("size-4", refreshing && "animate-spin")} />
            </Button>
          </div>
        }
      >
        <SettingsSection title={t('Prompt templates')} divider={false} settingsItem="prompt-templates.create">
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
            <SnippetCardSkeleton count={6} />
          </div>
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  const emptyState = filteredPrompts.length === 0 && prompts.length === 0;

  return (
    <SettingsPageLayout
      title={isMobile ? undefined : t('Prompt templates')}
      description={isMobile ? undefined : t('Native Pi commands that run as /name with Pi argument expansion.')}
      headerEnd={
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-full">
            <Icon
              name="search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={promptQuery}
              onChange={(e) => setPromptQuery(e.target.value)}
              placeholder={t('Search prompt templates')}
              aria-label={t('Search prompt templates')}
              className="h-9 w-[18rem] max-w-full pl-8"
            />
            {promptQuery ? (
              <button
                type="button"
                onClick={() => setPromptQuery("")}
                aria-label={t('Clear search')}
                className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="close" className="size-4" />
              </button>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void refreshPrompts()}
            disabled={refreshing}
            aria-label={t('Refresh prompt templates')}
            title={t('Refresh prompt templates')}
          >
            <Icon name="refresh" className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleCreateNew()}>
            <Icon name="add" className="size-4" />
            {t('New prompt')}
          </Button>
        </div>
      }
    >
      {emptyState ? (
        <SettingsSection title={t('Prompt templates')} divider={false} settingsItem="prompt-templates.create">
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Icon name="terminal" className="size-8 text-muted-foreground/60" aria-hidden />
            <p className="typography-meta text-muted-foreground">{t('No prompt templates yet')}</p>
            <p className="typography-micro max-w-sm text-muted-foreground">
              {t('Prompt templates are native Pi commands. Create one and run it in chat as')}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">/my-prompt</code>.
            </p>
            <Button variant="outline" size="sm" onClick={() => void handleCreateNew()}>
              <Icon name="add" className="size-4" />
              {t('New prompt')}
            </Button>
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection title={t('Prompt templates')} divider={false} settingsItem="prompt-templates.create">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Button variant="chip" size="xs" aria-pressed={locationFilter === "all"} onClick={() => setLocationFilter("all")}>
              {t('All')} {locationCounts.all}
            </Button>
            <Button variant="chip" size="xs" aria-pressed={locationFilter === "project"} onClick={() => setLocationFilter("project")}>
              {t('Project')} {locationCounts.project}
            </Button>
            <Button variant="chip" size="xs" aria-pressed={locationFilter === "global"} onClick={() => setLocationFilter("global")}>
              {t('Global')} {locationCounts.global}
            </Button>
          </div>
          {filteredPrompts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <p className="typography-meta text-muted-foreground">
                {promptQuery.trim() ? t('No prompt templates match “{{query}}”.', { query: promptQuery }) : t('No {{filter}} prompt templates.', { filter: locationFilter })}
              </p>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setPromptQuery("");
                  setLocationFilter("all");
                }}
              >
                {t('Clear filters')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
              {filteredPrompts.map((prompt) => {
                const isEditableCard = prompt.editable === true;
                const locLabel =
                  prompt.location === "project"
                    ? t('Project')
                    : prompt.location === "global"
                      ? t('Global')
                      : prompt.location;
                const preview =
                  prompt.description?.trim() ||
                  (prompt.content ?? "").replace(/\s+/g, " ").trim().slice(0, 140) ||
                  t('No description');
                return (
                  <button
                    key={prompt.id}
                    type="button"
                    onClick={() => setSelectedPrompt(prompt.id)}
                    aria-label={isEditableCard
                      ? t('{{name}} prompt template, {{location}}', { name: prompt.name, location: locLabel })
                      : t('{{name}} prompt template, {{location}}, read-only', { name: prompt.name, location: locLabel })}
                    className={cn(
                      "group flex min-h-[118px] flex-col gap-3 rounded-xl border bg-[var(--surface-elevated)] p-4 text-left",
                      "border-border/60 hover:bg-interactive-hover hover:border-border",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]",
                      "transition-colors duration-150",
                    )}
                  >
                    <div className="flex justify-start gap-1.5">
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 typography-micro font-medium capitalize",
                          prompt.location === "project"
                            ? "bg-[var(--primary-base)]/10 text-[var(--primary-base)]"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {locLabel}
                      </span>
                      {!isEditableCard ? (
                        <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 typography-micro font-medium text-muted-foreground">
                          {t('Read-only')}
                        </span>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate typography-ui-label font-medium text-foreground">/{prompt.name}</div>
                      <div className="mt-1 line-clamp-2 typography-micro text-muted-foreground">{preview}</div>
                    </div>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => void handleCreateNew()}
                aria-label={t('Create new prompt template')}
                className={cn(
                  "group flex min-h-[118px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4",
                  "border-border/60 bg-transparent text-muted-foreground",
                  "hover:border-border hover:bg-interactive-hover hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]",
                  "transition-colors duration-150",
                )}
              >
                <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted">
                  <Icon name="add" className="size-5" />
                </span>
                <span className="typography-ui-label font-medium">{t('New prompt')}</span>
                <span className="typography-micro text-muted-foreground">{t('Native / command')}</span>
              </button>
            </div>
          )}
        </SettingsSection>
      )}
    </SettingsPageLayout>
  );
};
