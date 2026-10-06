import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { GitHubAPI, GitHubIssueTemplate } from '@/lib/api/types';
import { toast } from '@/components/ui';
import { useGitHubIssuesStore } from '@/stores/useGitHubIssuesStore';
import { GitHubDetailScaffold } from '../GitHubDetailScaffold';
import { GitHubAssigneePicker, GitHubLabelPicker, useRepoMeta } from '../GitHubMetaPickers';
import { applyIssueTemplateBody, validateCreateIssue } from './issueLogic';

/**
 * New issue form: title, body, labels, assignees.
 *
 * Repository markdown templates (from the server `templates` route) pre-fill
 * an empty body or append after a blank line — never overwriting typed text.
 * YAML issue forms are not offered (the server skips them); the template
 * picker says so when the repository defines nothing usable.
 */
export const NewIssueForm: React.FC<{
  directory: string;
  repo: string;
  github: GitHubAPI;
  onCreated: (number: number) => void;
  onCancel: () => void;
}> = ({ directory, repo, github, onCreated, onCancel }) => {
  const { t } = useTranslation();
  const createIssue = useGitHubIssuesStore((state) => state.createIssue);
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [labels, setLabels] = React.useState<string[]>([]);
  const [assignees, setAssignees] = React.useState<string[]>([]);
  const [templateName, setTemplateName] = React.useState('');
  const [templates, setTemplates] = React.useState<GitHubIssueTemplate[]>([]);
  const [templatesNote, setTemplatesNote] = React.useState<string | null>(null);
  const { labels: metaLabels, assignees: metaAssignees, loading: metaLoading } = useRepoMeta(directory, repo, github);
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<{ title?: string; body?: string }>({});

  React.useEffect(() => {
    let cancelled = false;
    github
      .issueTemplates(directory, repo)
      .then((result) => {
        if (cancelled) return;
        setTemplates(result.templates);
        setTemplatesNote(result.templates.length === 0 ? t('No markdown templates in this repository. YAML issue forms are not supported.') : null);
      })
      .catch(() => {
        if (!cancelled) setTemplatesNote(t('Issue templates are unavailable.'));
      });
    return () => {
      cancelled = true;
    };
  }, [github, directory, repo, t]);

  const applyTemplate = (filename: string) => {
    setTemplateName(filename);
    if (!filename) return;
    const template = templates.find((entry) => entry.filename === filename);
    if (!template) return;
    setBody((prev) => applyIssueTemplateBody(prev, template.body));
  };

  const submit = async () => {
    const validation = validateCreateIssue({ title, body });
    setErrors(validation.errors);
    if (!validation.ok) return;
    setSaving(true);
    try {
      const result = await createIssue(
        {
          directory,
          repo,
          title: title.trim(),
          body: body.trim() ? body : undefined,
          labels: labels.length > 0 ? labels : undefined,
          assignees: assignees.length > 0 ? assignees : undefined,
        },
        github,
      );
      if (!result.ok || typeof result.number !== 'number') {
        toast.error(result.error?.kind === 'failed' ? result.error.message : t('Could not create the issue'));
        return;
      }
      toast.success(t('Issue #{{number}} created', { number: result.number }));
      onCreated(result.number);
    } finally {
      setSaving(false);
    }
  };

  return (
    <GitHubDetailScaffold
      header={
        <div className="flex h-7 min-w-0 items-center gap-1 px-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onCancel}
            title={t("Back to issues")}
            aria-label={t("Back to issues")}
            className="size-6 shrink-0"
          >
            <Icon name="arrow-left" className="size-4" />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{t('New issue')}</h1>
        </div>
      }
      tabs={[]}
      activeTab=""
      onTabChange={() => {}}
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="new-issue-title" className="typography-micro font-medium text-muted-foreground">{t('Title')}</label>
          <Input
            id="new-issue-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("Short summary")}
            aria-label={t("Issue title")}
            className="h-8"
            maxLength={300}
          />
          {errors.title ? <p className="typography-micro text-[var(--status-error)]" role="alert">{errors.title}</p> : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="new-issue-template" className="typography-micro font-medium text-muted-foreground">{t('Template')}</label>
          <select
            id="new-issue-template"
            aria-label={t("Issue template")}
            value={templateName}
            onChange={(event) => applyTemplate(event.target.value)}
            className="h-8 rounded-md border border-border bg-[var(--surface-elevated)] px-2 typography-micro text-foreground"
          >
            <option value="">{t('No template')}</option>
            {templates.map((template) => (
              <option key={template.filename} value={template.filename}>
                {template.name}
              </option>
            ))}
          </select>
          {templatesNote ? <p className="typography-micro text-muted-foreground">{templatesNote}</p> : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="new-issue-body" className="typography-micro font-medium text-muted-foreground">{t('Body')}</label>
          <Textarea
            id="new-issue-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={t("Describe the issue")}
            aria-label={t("Issue body")}
            rows={8}
          />
          {errors.body ? <p className="typography-micro text-[var(--status-error)]" role="alert">{errors.body}</p> : null}
        </div>

        <div className="flex flex-col gap-1">
          <span className="typography-micro font-medium text-muted-foreground">{t('Labels')}</span>
          <GitHubLabelPicker candidates={metaLabels} loading={metaLoading} selected={labels} onChange={setLabels} />
        </div>

        <div className="flex flex-col gap-1">
          <span className="typography-micro font-medium text-muted-foreground">{t('Assignees')}</span>
          <GitHubAssigneePicker candidates={metaAssignees} loading={metaLoading} selected={assignees} onChange={setAssignees} />
        </div>

        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={submit} disabled={saving || !title.trim()} aria-label={t("Create issue")}>
            {saving ? t('Creating…') : t('Create issue')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
            {t('Cancel')}
          </Button>
        </div>
      </div>
    </GitHubDetailScaffold>
  );
};
