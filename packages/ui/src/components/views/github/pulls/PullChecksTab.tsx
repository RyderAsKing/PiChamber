import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type {
  GitHubAPI,
  GitHubCheckRun,
  GitHubCheckStatus,
  GitHubChecksResult,
  GitHubErrorBody,
} from '@/lib/api/types';
import { GitHubChecksGlyph } from '../GitHubDetailScaffold';
import { SectionError } from '../GitHubListPrimitives';
import { useGitHubPullRequestsStore } from '@/stores/useGitHubPullRequestsStore';
import { useSendGitHubContextToComposer } from './useSendGitHubContextToComposer';
import { describeChecksRollup, isFailedCheckRun } from './pullLogic';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Checks tab: the flat check rows moved out of Summary, with a rollup line
 * at the top (`2 failing · 1 pending · 5 passed`), per-run re-run / details
 * / send-to-agent actions, and section errors rendered in place.
 */
export const PullChecksTab: React.FC<{
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  checks: GitHubChecksResult | null;
  checksError: GitHubErrorBody | null;
  checksLoading: boolean;
  onRetryChecks: () => void;
  onOpenFilesAtLine?: (path: string, line: number) => void;
}> = ({ directory, repo, number, github, checks, checksError, checksLoading, onRetryChecks, onOpenFilesAtLine }) => {
  const { t } = useTranslation();
  const [expandedJobs, setExpandedJobs] = React.useState<Record<string, boolean>>({});
  const [jobSteps, setJobSteps] = React.useState<
    Record<string, { steps: { name: string; conclusion?: string | null; status?: string | null }[]; loading: boolean }>
  >({});
  const { send, sendingKey } = useSendGitHubContextToComposer();
  const rollup = describeChecksRollup(checks);

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 px-1 py-1">
        <p className="min-w-0 flex-1 typography-micro text-muted-foreground" aria-live="polite">
          {rollup ? rollup.text : checksLoading ? t('Loading checks…') : t('No checks reported for this pull request.')}
        </p>
        {rollup && rollup.failed > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              void send({
                key: `pr-${number}-failed-checks`,
                kind: 'checks',
                directory,
                repo,
                number,
                contextType: 'checks',
              })
            }
            disabled={sendingKey === `pr-${number}-failed-checks`}
            aria-label={t("Send failed checks to agent")}
            title={t("Send failed checks to agent")}
          >
            <Icon name="send-plane-2" className="size-3.5" />
            {t('Send failures to agent')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="xs" onClick={onRetryChecks} aria-label={t("Refresh checks")} title={t("Refresh checks")}>
          <Icon name="refresh" className={cn('size-3.5', checksLoading && 'animate-spin')} />
          {t('Refresh')}
        </Button>
      </div>
      <SectionError error={checksError} onRetry={onRetryChecks} label={t("Checks")} />
      {checks ? (
        <ChecksList
          checks={checks}
          directory={directory}
          repo={repo}
          number={number}
          github={github}
          expandedJobs={expandedJobs}
          onToggleJob={(key) => setExpandedJobs((prev) => ({ ...prev, [key]: !prev[key] }))}
          jobSteps={jobSteps}
          setJobSteps={setJobSteps}
          sendingKey={sendingKey}
          send={send}
          onOpenFilesAtLine={onOpenFilesAtLine}
        />
      ) : null}
    </div>
  );
};

const ChecksList: React.FC<{
  checks: GitHubChecksResult;
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  expandedJobs: Record<string, boolean>;
  onToggleJob: (key: string) => void;
  jobSteps: Record<string, { steps: { name: string; conclusion?: string | null; status?: string | null }[]; loading: boolean }>;
  setJobSteps: React.Dispatch<React.SetStateAction<Record<string, { steps: { name: string; conclusion?: string | null; status?: string | null }[]; loading: boolean }>>>;
  sendingKey: string | null;
  send: ReturnType<typeof useSendGitHubContextToComposer>['send'];
  onOpenFilesAtLine?: (path: string, line: number) => void;
}> = ({ checks, directory, repo, number, github, expandedJobs, onToggleJob, jobSteps, setJobSteps, sendingKey, send, onOpenFilesAtLine }) => {
  const { t } = useTranslation();
  const rerunFailedChecks = useGitHubPullRequestsStore((state) => state.rerunFailedChecks);
  const [annotations, setAnnotations] = React.useState<Record<number, { loading: boolean; items: { path?: string | null; startLine?: number | null; message: string; title?: string | null }[] }>>({});

  const loadSteps = async (run: GitHubCheckRun) => {
    const key = `run-${run.id ?? run.name}`;
    onToggleJob(key);
    if (expandedJobs[key] || jobSteps[key] || run.id == null) return;
    setJobSteps((prev) => ({ ...prev, [key]: { steps: [], loading: true } }));
    try {
      // The check-run id of an Actions run is its job id.
      const result = await github.checkJobs(directory, repo, run.runId ?? null, run.id);
      const job = result.jobs[0];
      setJobSteps((prev) => ({ ...prev, [key]: { steps: job?.steps ?? [], loading: false } }));
      const annotationsResult = await github.checkAnnotations(directory, repo, run.id).catch(() => null);
      if (annotationsResult) {
        setAnnotations((prev) => ({ ...prev, [run.id as number]: { loading: false, items: annotationsResult.annotations } }));
      }
    } catch {
      setJobSteps((prev) => ({ ...prev, [key]: { steps: [], loading: false } }));
    }
  };

  const rerunFailed = async (runId: number) => {
    const result = await rerunFailedChecks(directory, repo, runId, github);
    if (!result.ok) toast.error(t('Re-run failed'));
    else toast.success(t('Re-run requested'));
  };

  const renderRun = (run: GitHubCheckRun) => {
    const key = `run-${run.id ?? run.name}`;
    const expanded = expandedJobs[key] ?? false;
    const steps = jobSteps[key];
    const failed = isFailedCheckRun(run);
    return (
      <div key={key} className="rounded-md px-2 py-2 hover:bg-interactive-hover">
        <div className="flex flex-wrap items-center gap-1.5">
          <GitHubChecksGlyph state={run.conclusion ?? run.status} />
          <span className="min-w-0 flex-1 truncate typography-ui text-foreground" title={run.name}>
            {run.name}
          </span>
          {run.conclusion ? <span className="typography-micro text-muted-foreground">{run.conclusion}</span> : null}
          <Button type="button" variant="ghost" size="xs" onClick={() => void loadSteps(run)} aria-expanded={expanded} aria-label={expanded ? t('Collapse {{name}}', { name: run.name }) : t('Expand {{name}}', { name: run.name })}>
            {t('Details')}
          </Button>
          {failed && run.runId != null ? (
            <Button type="button" variant="outline" size="xs" onClick={() => void rerunFailed(run.runId as number)}>
              {t('Re-run')}
            </Button>
          ) : null}
          {failed ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void send({ key: `${key}-agent`, kind: 'check', directory, repo, number, contextType: 'checks', detail: run.name })}
              disabled={sendingKey === `${key}-agent`}
              aria-label={t('Send {{name}} to agent', { name: run.name })}
            >
              {t('Send to agent')}
            </Button>
          ) : null}
        </div>
        {expanded ? (
          <div className="mt-1.5 flex flex-col gap-1 border-t border-border/60 pt-1.5">
            {steps?.loading ? <span className="typography-micro text-muted-foreground">{t('Loading steps…')}</span> : null}
            {(steps?.steps ?? []).map((step, index) => (
              <div key={`${step.name}-${index}`} className="flex items-center gap-1.5 typography-micro text-muted-foreground">
                <GitHubChecksGlyph state={step.conclusion ?? step.status} />
                <span className="truncate">{step.name}</span>
                {step.conclusion ? <span>· {step.conclusion}</span> : null}
              </div>
            ))}
            {run.id != null && annotations[run.id]?.items?.length ? (
              <div className="flex flex-col gap-1">
                {annotations[run.id]?.items.map((annotation, index) => (
                  <div key={index} className="typography-micro text-muted-foreground">
                    {annotation.path && annotation.startLine && onOpenFilesAtLine ? (
                      <button
                        type="button"
                        className="font-mono underline"
                        onClick={() => onOpenFilesAtLine(annotation.path as string, annotation.startLine as number)}
                      >
                        {annotation.path}:{annotation.startLine}
                      </button>
                    ) : (
                      <span className="font-mono">
                        {annotation.path}
                        {annotation.startLine ? `:${annotation.startLine}` : ''}
                      </span>
                    )}{' '}
                    {annotation.title ? <span className="text-foreground">{annotation.title} — </span> : null}
                    {annotation.message}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderStatus = (status: GitHubCheckStatus, index: number) => (
    <div key={`${status.context}-${index}`} className="flex items-center gap-1.5 rounded-md px-2 py-2 hover:bg-interactive-hover">
      <GitHubChecksGlyph state={status.state} />
      <span className="min-w-0 flex-1 truncate typography-ui text-foreground" title={status.context}>
        {status.context}
      </span>
      {status.description ? <span className="truncate typography-micro text-muted-foreground">{status.description}</span> : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-1">
      {checks.sectionErrors?.runs || checks.sectionErrors?.statuses ? (
        <div className="rounded-md border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-2 py-1 typography-micro text-foreground" role="alert">
          {t('Some check sources failed to load; counts below are partial, not empty.')}
        </div>
      ) : null}
      {checks.runs.length > 0 ? (
        <div className="flex flex-col" aria-label={t("Check runs")}>
          {checks.runs.map(renderRun)}
        </div>
      ) : null}
      {checks.statuses.length > 0 ? (
        <div className="flex flex-col" aria-label={t("Commit statuses")}>
          {checks.statuses.map(renderStatus)}
        </div>
      ) : null}
      {checks.runs.length === 0 && checks.statuses.length === 0 ? (
        <p className="typography-ui text-muted-foreground">{t('No checks reported for this pull request.')}</p>
      ) : null}
    </div>
  );
};
