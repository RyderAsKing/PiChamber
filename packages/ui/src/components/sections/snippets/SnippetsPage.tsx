import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsFieldRow, SettingsSection, SettingsStackedField, SETTINGS_SELECT_SIZE } from '@/components/sections/shared/SettingsSection';
import { ProjectTrustDialog } from '@/components/sections/shared/ProjectTrustDialog';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Icon } from '@/components/icon/Icon';
import { useSnippetsStore, type SnippetScope } from '@/stores/useSnippetsStore';

/** Native Pi prompt-template editor. Templates expand as `/name` in Pi. */
export const SnippetsPage: React.FC = () => {
  
  const selectedName = useSnippetsStore((state) => state.selectedSnippetName);
  const draft = useSnippetsStore((state) => state.snippetDraft);
  const snippets = useSnippetsStore((state) => state.snippets);
  const setSnippetDraft = useSnippetsStore((state) => state.setSnippetDraft);
  const createSnippet = useSnippetsStore((state) => state.createSnippet);
  const updateSnippet = useSnippetsStore((state) => state.updateSnippet);
  const selected = snippets.find((snippet) => snippet.name === selectedName) ?? null;
  const isNew = Boolean(draft && !selected);
  const [name, setName] = React.useState('');
  const [scope, setScope] = React.useState<SnippetScope>('global');
  const [description, setDescription] = React.useState('');
  const [content, setContent] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const originalContent = React.useRef('');

  React.useEffect(() => {
    if (isNew && draft) {
      setName(draft.name);
      setScope(draft.scope);
      setDescription(draft.description ?? '');
      setContent(draft.content ?? '');
      originalContent.current = draft.content ?? '';
    } else if (selected) {
      setName(selected.name);
      setScope(selected.source);
      setDescription(selected.description ?? '');
      setContent(selected.content);
      originalContent.current = selected.content;
    }
  }, [draft, isNew, selected]);

  const save = async () => {
    const normalizedName = name.trim().replace(/\s+/g, '-');
    if (!normalizedName) { toast.error("Template name is required"); return; }
    if (!content.trim()) { toast.error("Snippet content is required"); return; }
    setSaving(true);
    const success = isNew
      ? await createSnippet(normalizedName, content, { description, scope })
      : await updateSnippet(selected?.name ?? normalizedName, { content });
    setSaving(false);
    if (success) {
      setSnippetDraft(null);
      toast.success((isNew ? "Template created" : "Template updated"));
    } else {
      toast.error((isNew ? "Failed to create template" : "Failed to update template"));
    }
  };

  if (!selectedName) {
    return <><ProjectTrustDialog onResolved={() => { void useSnippetsStore.getState().loadSnippets(); }} /><div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground"><div><Icon name="file-text" className="mx-auto mb-3 size-10 opacity-50" /><p className="typography-body">{"Select a template"}</p><p className="typography-meta mt-1">{"Choose a template from the sidebar to edit it."}</p></div></div></>;
  }

  return (
    <><ProjectTrustDialog onResolved={() => { void useSnippetsStore.getState().loadSnippets(); }} /><SettingsPageLayout title={isNew ? "New template" : `/${name}`} description={isNew ? "Create a new prompt template" : description} showSaveStatus={false}>
      {isNew ? <SettingsSection title={"Identity"} divider={false}>
        <SettingsFieldRow label={"Name"}>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={"Template name"} className="h-8 w-full max-w-48" />
          <Select value={scope} onValueChange={(value) => setScope(value as SnippetScope)}><SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full max-w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="global">{"Global"}</SelectItem><SelectItem value="project">{"Project"}</SelectItem></SelectContent></Select>
        </SettingsFieldRow>
        <SettingsStackedField label={"Description"}><Input value={description} onChange={(event) => setDescription(event.target.value)} className="h-8 w-full" /></SettingsStackedField>
      </SettingsSection> : null}
      <SettingsSection title={"Template"} divider={!isNew} settingsItem="snippets.content" contentClassName="space-y-3">
        <Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={"Enter the prompt template text..."} rows={14} disabled={!isNew && selected?.editable !== true} className="min-h-[220px] w-full font-mono typography-meta bg-transparent" />
        {isNew || selected?.editable === true ? <Button size="xs" onClick={() => void save()} disabled={saving || (!isNew && content === originalContent.current)}>{saving ? "Saving..." : "Save Changes"}</Button> : null}
      </SettingsSection>
    </SettingsPageLayout></>
  );
};
