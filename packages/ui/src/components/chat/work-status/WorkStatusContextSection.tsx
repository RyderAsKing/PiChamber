import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useSession } from '@/sync/sync-context';
import { getLinkedIssues } from '@/lib/linkedIssues';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

/**
 * What is loaded into the agent's context: the GitHub threads this session was
 * pointed at, plus how much ambient material is available.
 */
export const WorkStatusContextSection: React.FC<Props> = ({ sessionId, directory }) => {
  

  const session = useSession(sessionId ?? '', directory ?? undefined);
  const skills = useSkillsStore((state) => state.skills);

  const loadSkills = useSkillsStore((state) => state.loadSkills);
  React.useEffect(() => {
    void loadSkills();
  }, [directory, loadSkills]);

  const linked = React.useMemo(() => getLinkedIssues(session), [session]);

  useReportWorkStatusPresence('context-sources', linked.length > 0 || skills.length > 0);

  if (linked.length === 0 && skills.length === 0) return null;

  const issueCount = linked.filter((entry) => entry.kind === 'issue').length;
  const prCount = linked.length - issueCount;
  const summaryParts: string[] = [];
  if (issueCount > 0) {
    summaryParts.push(issueCount === 1
      ? `${issueCount} issue`
      : `${issueCount} issues`);
  }
  if (prCount > 0) {
    summaryParts.push(prCount === 1
      ? `${prCount} PR`
      : `${prCount} PRs`);
  }
  if (summaryParts.length === 0) {
    if (skills.length > 0) {
      summaryParts.push(skills.length === 1
        ? `${skills.length} skill`
        : `${skills.length} skills`);
    }
  }

  return (
    <WorkStatusCollapsibleSection
      id="context-sources"
      title={"Context sources"}
      icon="stack"
      summary={summaryParts.join(' · ')}
    >
      {/* Attached threads first: they are specific to this session, while the
          counts below describe the workspace. */}
      {linked.map((entry) => (
        <WorkStatusRow
          key={entry.id}
          leading={entry.authorAvatarUrl ? (
            <img src={entry.authorAvatarUrl} alt="" className="size-4 shrink-0 rounded-full" loading="lazy" />
          ) : (
            <Icon
              name={entry.kind === 'pull' ? 'git-pull-request' : 'error-warning'}
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
          label={entry.title}
          muted
          onClick={() => window.open(entry.url, '_blank', 'noopener,noreferrer')}
          ariaLabel={`Open #${entry.number} on GitHub`}
          value={<WorkStatusValue tone="muted">{`#${entry.number}`}</WorkStatusValue>}
        />
      ))}

      <WorkStatusRow
        muted
        label={"Skills"}
        value={<WorkStatusValue>{skills.length}</WorkStatusValue>}
      />
    </WorkStatusCollapsibleSection>
  );
};
