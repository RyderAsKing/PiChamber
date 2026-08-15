import React from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { ProjectTrustDialog } from '@/components/sections/shared/ProjectTrustDialog';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { piClient } from '@/lib/pi/client';
import type { PiResource } from '@/lib/pi/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

/** Pi global and applicable project instruction files. Pi, rather than PiChamber, remains their source of truth. */
export const BehaviorPage: React.FC = () => {
  
  const [agents, setAgents] = React.useState<PiResource[] | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const resources = await piClient.listResources({ runtimeKey: getRuntimeKey() });
    setAgents(resources.agents);
    setDrafts(Object.fromEntries(resources.agents.map((agent) => [agent.id, agent.content ?? ''])));
    setFailed(false);
  }, []);

  React.useEffect(() => { void refresh().catch(() => setFailed(true)); }, [refresh]);

  const save = async (agent: PiResource) => {
    setSaving(agent.id);
    try {
      const resources = await piClient.updateResource({ resourceId: agent.id, content: drafts[agent.id] ?? '' }, { runtimeKey: getRuntimeKey() });
      setAgents(resources.agents);
      setDrafts(Object.fromEntries(resources.agents.map((item) => [item.id, item.content ?? ''])));
      toast.success("Behavior saved successfully");
    } catch {
      toast.error("Failed to save behavior");
    } finally {
      setSaving(null);
    }
  };

  return <>
    <ProjectTrustDialog onResolved={() => { void refresh().catch(() => setFailed(true)); }} />
    <SettingsPageLayout title={"Behavior"} description={"Guide how the agent responds."} showSaveStatus={false}>
      {failed ? <p className="typography-meta text-[var(--status-error)]">{"Unavailable"}</p> : null}
      {(agents ?? []).map((agent, index) => {
        const content = drafts[agent.id] ?? '';
        const title = agent.location === 'global' ? "Global AGENTS.md" : `${"Project"} ${agent.name}`;
        return <SettingsSection key={agent.id} title={title} divider={index > 0} settingsItem={agent.location === 'global' ? 'behavior.global-agents' : 'behavior.project-agents'} contentClassName="space-y-3">
          <Textarea value={content} onChange={(event) => setDrafts((current) => ({ ...current, [agent.id]: event.target.value }))} rows={12} disabled={agent.editable !== true} outerClassName="min-h-[180px] max-h-[70vh]" className="w-full font-mono typography-meta bg-transparent" />
          {agent.editable === true ? <Button size="xs" onClick={() => void save(agent)} disabled={saving !== null || content === (agent.content ?? '')}>{saving === agent.id ? "Saving..." : "Save Changes"}</Button> : null}
        </SettingsSection>;
      })}
    </SettingsPageLayout>
  </>;
};
