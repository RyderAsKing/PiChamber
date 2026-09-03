import React from "react";

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
import { useSnippetsStore, type SnippetScope } from "@/stores/useSnippetsStore";
import { useEffectiveDirectory } from "@/hooks/useEffectiveDirectory";
import { SnippetCard, SnippetCardSkeleton } from "./SnippetCard";
import { SnippetMarkdownEditor } from "./SnippetMarkdownEditor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const parseAliasesInput = (value: string): string[] => {
  return value
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
};

/** PiChamber-owned snippets — literal `#name` text expansion. */
export const SnippetsPage: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const effectiveDirectory = useEffectiveDirectory();
  const selectedId = useSnippetsStore((state) => state.selectedSnippetId);
  const draft = useSnippetsStore((state) => state.snippetDraft);
  const snippets = useSnippetsStore((state) => state.snippets);
  const isLoading = useSnippetsStore((state) => state.isLoading);
  const setSelectedSnippet = useSnippetsStore(
    (state) => state.setSelectedSnippet,
  );
  const setSnippetDraft = useSnippetsStore((state) => state.setSnippetDraft);
  const createSnippet = useSnippetsStore((state) => state.createSnippet);
  const updateSnippet = useSnippetsStore((state) => state.updateSnippet);
  const deleteSnippet = useSnippetsStore((state) => state.deleteSnippet);
  const loadSnippets = useSnippetsStore((state) => state.loadSnippets);

  const selected = React.useMemo(
    () =>
      selectedId
        ? (snippets.find((snippet) => snippet.id === selectedId) ?? null)
        : null,
    [selectedId, snippets],
  );
  const isNew = Boolean(draft && !selected);

  const [name, setName] = React.useState("");
  const [scope, setScope] = React.useState<SnippetScope>("global");
  const [description, setDescription] = React.useState("");
  const [aliasesInput, setAliasesInput] = React.useState("");
  const [content, setContent] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = React.useState(false);
  const originalContent = React.useRef("");
  const originalDescription = React.useRef("");
  const originalName = React.useRef("");
  const originalAliases = React.useRef("");
  const originalScope = React.useRef<SnippetScope>("global");

  React.useEffect(() => {
    if (isNew && draft) {
      setName(draft.name);
      setScope(draft.scope);
      setDescription(draft.description ?? "");
      setAliasesInput("");
      setContent(draft.content ?? "");
      originalContent.current = draft.content ?? "";
      originalDescription.current = draft.description ?? "";
      originalName.current = draft.name;
      originalAliases.current = "";
      originalScope.current = draft.scope;
    } else if (selected) {
      setName(selected.name);
      setScope(selected.source);
      setDescription(selected.description ?? "");
      setAliasesInput((selected.aliases ?? []).join(", "));
      setContent(selected.content);
      originalContent.current = selected.content;
      originalDescription.current = selected.description ?? "";
      originalName.current = selected.name;
      originalAliases.current = (selected.aliases ?? []).join(", ");
      originalScope.current = selected.source;
    }
  }, [draft, isNew, selected]);

  const handleBack = React.useCallback(() => {
    if (isNew) {
      setSnippetDraft(null);
    }
    setSelectedSnippet(null);
  }, [isNew, setSelectedSnippet, setSnippetDraft]);

  const handleSave = React.useCallback(async () => {
    const normalizedName = name.trim().replace(/\s+/g, "-");
    if (!normalizedName) {
      toast.error("Snippet name is required");
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(normalizedName)) {
      toast.error(
        "Snippet name may only contain letters, numbers, dashes and underscores",
      );
      return;
    }
    if (!content.trim()) {
      toast.error("Snippet content is required");
      return;
    }
    const aliases = parseAliasesInput(aliasesInput);
    if (aliases.length > 10) {
      toast.error("Snippets support at most 10 aliases");
      return;
    }
    for (const alias of aliases) {
      if (!/^[a-z0-9_-]+$/i.test(alias)) {
        toast.error(
          "Aliases may only contain letters, numbers, dashes and underscores",
        );
        return;
      }
    }
    if (scope === "project" && !effectiveDirectory?.trim()) {
      toast.error("Project snippets need an active project directory");
      return;
    }
    setSaving(true);
    const success = isNew
      ? await createSnippet(normalizedName, content, {
          description,
          aliases,
          scope,
          directory: effectiveDirectory,
        })
      : await updateSnippet(
          selected?.id ?? "",
          {
            name: normalizedName !== originalName.current ? normalizedName : undefined,
            content: content !== originalContent.current ? content : undefined,
            description:
              description !== originalDescription.current ? description : undefined,
            aliases:
              aliasesInput.trim() !== originalAliases.current.trim()
                ? aliases
                : undefined,
            ...(scope !== originalScope.current
              ? {
                  scope,
                  ...(scope === "project" && effectiveDirectory
                    ? { directory: effectiveDirectory }
                    : {}),
                }
              : {}),
          },
          effectiveDirectory,
        );
    setSaving(false);
    if (success) {
      if (!isNew) {
        setSnippetDraft(null);
      }
      toast.success(isNew ? "Snippet created" : "Snippet updated");
    } else {
      toast.error(
        isNew ? "Failed to create snippet" : "Failed to update snippet",
      );
    }
  }, [
    aliasesInput,
    content,
    createSnippet,
    description,
    effectiveDirectory,
    isNew,
    name,
    scope,
    selected?.id,
    setSnippetDraft,
    updateSnippet,
  ]);

  const handleDelete = React.useCallback(async () => {
    if (!selected) return;
    setDeleting(true);
    const success = await deleteSnippet(selected.id, effectiveDirectory);
    setDeleting(false);
    if (success) {
      toast.success("Snippet deleted");
      setConfirmDeleteOpen(false);
    } else {
      toast.error("Failed to delete snippet");
    }
  }, [deleteSnippet, effectiveDirectory, selected]);

  const [snippetQuery, setSnippetQuery] = React.useState("");
  const [scopeFilter, setScopeFilter] = React.useState<
    "all" | "global" | "project"
  >("all");
  const [refreshing, setRefreshing] = React.useState(false);

  const refreshSnippets = React.useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { invalidateSnippetsLoadCache } =
        await import("@/stores/useSnippetsStore");
      invalidateSnippetsLoadCache(effectiveDirectory);
      await loadSnippets(effectiveDirectory);
    } finally {
      setRefreshing(false);
    }
  }, [effectiveDirectory, loadSnippets, refreshing]);

  React.useEffect(() => {
    void loadSnippets(effectiveDirectory);
  }, [effectiveDirectory, loadSnippets]);

  const sortedSnippets = React.useMemo(
    () => [...snippets].sort((a, b) => a.name.localeCompare(b.name)),
    [snippets],
  );

  const filteredSnippets = React.useMemo(() => {
    let list = sortedSnippets;
    if (scopeFilter !== "all") {
      list = list.filter((s) => s.source === scopeFilter);
    }
    const q = snippetQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => {
      const nameMatch = s.name.toLowerCase().includes(q);
      const descMatch = (s.description ?? "").toLowerCase().includes(q);
      const contentMatch = s.content.toLowerCase().includes(q);
      const aliasMatch = (s.aliases ?? []).some((alias) =>
        alias.toLowerCase().includes(q),
      );
      return nameMatch || descMatch || contentMatch || aliasMatch;
    });
  }, [sortedSnippets, scopeFilter, snippetQuery]);

  const scopeCounts = React.useMemo(() => {
    let global = 0;
    let project = 0;
    for (const s of snippets) {
      if (s.source === "project") project += 1;
      else global += 1;
    }
    return { all: snippets.length, global, project };
  }, [snippets]);

  const handleCreateNew = React.useCallback(async () => {
    const existing = new Set(
      snippets.map((snippet) => snippet.name.toLowerCase()),
    );
    let newName = "new-snippet";
    let counter = 1;
    while (existing.has(newName.toLowerCase())) {
      newName = `new-snippet-${counter++}`;
    }
    setSnippetDraft({
      name: newName,
      scope: "global",
      content: "",
      description: "",
    });
    setSelectedSnippet(null);
  }, [setSelectedSnippet, setSnippetDraft, snippets]);

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
                aria-label="Back to snippets"
                className="-ml-1 h-7 w-7 p-0"
              >
                <Icon name="arrow-left-s" className="size-4" />
              </Button>
              <span className="truncate">Not found</span>
            </span>
          }
          description="This snippet no longer exists."
        >
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Icon
              name="file-text"
              className="size-8 text-muted-foreground/60"
              aria-hidden
            />
            <p className="typography-meta text-muted-foreground">
              The selected snippet was not found.
            </p>
            <Button variant="outline" size="sm" onClick={handleBack}>
              Back to snippets
            </Button>
          </div>
        </SettingsPageLayout>
      );
    }

    const isDirty = isNew
      ? name.trim() !== originalName.current ||
        description !== originalDescription.current ||
        content !== originalContent.current ||
        aliasesInput.trim() !== originalAliases.current.trim() ||
        scope !== originalScope.current
      : name.trim() !== originalName.current ||
        content !== originalContent.current ||
        description !== originalDescription.current ||
        aliasesInput.trim() !== originalAliases.current.trim() ||
        scope !== originalScope.current;
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
                aria-label="Back to snippets"
                className="-ml-1 h-7 w-7 p-0"
              >
                <Icon name="arrow-left-s" className="size-4" />
              </Button>
              <span className="truncate">
                {isNew ? "New snippet" : `#${selected?.name ?? name}`}
              </span>
            </span>
          }
          description={
            isNew ? (
              <span className="typography-settings-description text-muted-foreground">
                Create a reusable text snippet
              </span>
            ) : selected?.description ? (
              <span className="typography-settings-description text-muted-foreground">
                {selected.description}
              </span>
            ) : undefined
          }
          headerEnd={
            !isNew && selected ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setConfirmDeleteOpen(true)}
                className="text-destructive hover:text-destructive"
              >
                <Icon name="delete-bin" className="size-4" />
                Delete
              </Button>
            ) : null
          }
        >
          <SettingsSection
            title="Identity"
            divider={false}
            settingsItem="snippets.create"
          >
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="typography-settings-field-label text-foreground">
                    Name
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="typography-ui-label text-muted-foreground">
                      #
                    </span>
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="my-snippet"
                      className="h-9 flex-1 font-mono"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                  <p className="typography-micro text-muted-foreground">
                    Used as{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                      #{name.trim() || "name"}
                    </code>{" "}
                    in chat. Letters, numbers, dashes and underscores only.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="typography-settings-field-label text-foreground">
                    Scope
                  </label>
                  <Select
                    value={scope}
                    onValueChange={(value) => setScope(value as SnippetScope)}
                  >
                    <SelectTrigger
                      size={SETTINGS_SELECT_SIZE}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">Global</SelectItem>
                      <SelectItem value="project">Project</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="typography-micro text-muted-foreground">
                    {scope === "project"
                      ? "Available only in this project. Project snippets override same-named global snippets."
                      : "Available in every project."}
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="typography-settings-field-label text-foreground">
                  Description
                </label>
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What does this snippet do?"
                  className="h-9 w-full"
                />
                <p className="typography-micro text-muted-foreground">
                  Optional. Shown in the snippet card and autocomplete.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="typography-settings-field-label text-foreground">
                  Aliases
                </label>
                <Input
                  value={aliasesInput}
                  onChange={(event) => setAliasesInput(event.target.value)}
                  placeholder="shortcut, alt-name"
                  className="h-9 w-full font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="typography-micro text-muted-foreground">
                  Optional alternate # triggers, comma-separated. They expand
                  to the same literal text.
                </p>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Content"
            divider
            settingsItem="snippets.content"
            info="Snippets perform literal text replacement. Type #name in chat to insert the content."
            headerAction={
              <span className="typography-micro text-muted-foreground">
                {isDirty ? "Unsaved changes" : "No changes"}
              </span>
            }
          >
            <SnippetMarkdownEditor
              key={
                isNew
                  ? "new-snippet-editor"
                  : `snippet-editor:${selected?.id ?? ""}`
              }
              value={content}
              onChange={setContent}
              initialMode={isNew ? "write" : "preview"}
              triggerPreview={`#${name.trim() || "name"}`}
            />
            <div className="flex items-center justify-between gap-3 pt-2">
              <Button variant="ghost" size="sm" onClick={handleBack}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={!canSave}
              >
                {saving ? "Saving…" : isNew ? "Create snippet" : "Save changes"}
              </Button>
            </div>
          </SettingsSection>

          {!isNew && selected ? (
            <SettingsSection title="Danger zone" divider>
              <div className="flex items-center justify-between gap-4 rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-3">
                <div className="min-w-0">
                  <div className="typography-ui-label font-medium text-foreground">
                    Delete snippet
                  </div>
                  <div className="typography-micro text-muted-foreground">
                    Permanently remove #{selected.name}. This cannot be undone.
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmDeleteOpen(true)}
                  disabled={deleting}
                >
                  <Icon name="delete-bin" className="size-4" />
                  Delete
                </Button>
              </div>
            </SettingsSection>
          ) : null}
        </SettingsPageLayout>

        <Dialog
          open={confirmDeleteOpen}
          onOpenChange={(open) => !open && setConfirmDeleteOpen(false)}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete snippet?</DialogTitle>
              <DialogDescription>
                This will permanently delete #{selected?.name ?? ""}. This
                cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDeleteOpen(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  if (isLoading && snippets.length === 0) {
    return (
      <SettingsPageLayout
        title={isMobile ? undefined : "Snippets"}
        description={
          isMobile
            ? undefined
            : "Text snippets that expand as #name in the composer."
        }
        headerEnd={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refreshSnippets()}
              disabled={refreshing}
              aria-label="Refresh snippets"
              title="Refresh snippets"
            >
              <Icon
                name="refresh"
                className={cn("size-4", refreshing && "animate-spin")}
              />
            </Button>
          </div>
        }
      >
        <SettingsSection
          title="Snippets"
          divider={false}
          settingsItem="snippets.create"
        >
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
            <SnippetCardSkeleton count={6} />
          </div>
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  const emptyState = filteredSnippets.length === 0 && snippets.length === 0;

  return (
    <SettingsPageLayout
      title={isMobile ? undefined : "Snippets"}
      description={
        isMobile
          ? undefined
          : "Text snippets that expand as #name in the composer."
      }
      headerEnd={
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Icon
              name="search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={snippetQuery}
              onChange={(event) => setSnippetQuery(event.target.value)}
              placeholder="Search snippets"
              aria-label="Search snippets"
              className="h-9 w-[18rem] max-w-[24rem] pl-8"
            />
            {snippetQuery ? (
              <button
                type="button"
                onClick={() => setSnippetQuery("")}
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
            onClick={() => void refreshSnippets()}
            disabled={refreshing}
            aria-label="Refresh snippets"
            title="Refresh snippets"
          >
            <Icon
              name="refresh"
              className={cn("size-4", refreshing && "animate-spin")}
            />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCreateNew()}
          >
            <Icon name="add" className="size-4" />
            New snippet
          </Button>
        </div>
      }
    >
      {emptyState ? (
        <SettingsSection
          title="Snippets"
          divider={false}
          settingsItem="snippets.create"
        >
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Icon
              name="file-text"
              className="size-8 text-muted-foreground/60"
              aria-hidden
            />
            <p className="typography-meta text-muted-foreground">
              No snippets yet
            </p>
            <p className="typography-micro max-w-sm text-muted-foreground">
              Snippets are reusable text. Create one and use it in chat as{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                #my-snippet
              </code>
              .
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCreateNew()}
            >
              <Icon name="add" className="size-4" />
              New snippet
            </Button>
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection
          title="Snippets"
          divider={false}
          settingsItem="snippets.create"
        >
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Button
              variant="chip"
              size="xs"
              aria-pressed={scopeFilter === "all"}
              onClick={() => setScopeFilter("all")}
            >
              All {scopeCounts.all}
            </Button>
            <Button
              variant="chip"
              size="xs"
              aria-pressed={scopeFilter === "project"}
              onClick={() => setScopeFilter("project")}
            >
              Project {scopeCounts.project}
            </Button>
            <Button
              variant="chip"
              size="xs"
              aria-pressed={scopeFilter === "global"}
              onClick={() => setScopeFilter("global")}
            >
              Global {scopeCounts.global}
            </Button>
          </div>

          {filteredSnippets.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <p className="typography-meta text-muted-foreground">
                {snippetQuery.trim()
                  ? `No snippets match “${snippetQuery}”.`
                  : `No ${scopeFilter} snippets.`}
              </p>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setSnippetQuery("");
                  setScopeFilter("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
              {filteredSnippets.map((snippet) => (
                <SnippetCard
                  key={`${snippet.source}:${snippet.id}`}
                  snippet={snippet}
                  onSelect={setSelectedSnippet}
                  showSourcePill={scopeFilter === "all"}
                />
              ))}
              <button
                type="button"
                onClick={() => void handleCreateNew()}
                aria-label="Create new snippet"
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
                <span className="typography-ui-label font-medium">
                  New snippet
                </span>
                <span className="typography-micro text-muted-foreground">
                  Reusable text expansion
                </span>
              </button>
            </div>
          )}
        </SettingsSection>
      )}
    </SettingsPageLayout>
  );
};
