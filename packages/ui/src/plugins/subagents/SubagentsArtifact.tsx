import React from 'react';

import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import type { TurnArtifactProps } from '@/plugins/types';
import { useUIStore } from '@/stores/useUIStore';
import { MODE_LABEL, parseSubagentDetails, runsFromInput, summarizeRuns } from './details';
import { SubagentRunDetail } from './RunDetail';
import { useSubagentSelection } from './selection';
import { SubagentRunGrid } from './SubagentRuns';

/**
 * A `subagent` call: one card per run with its model, task, and status, live
 * while the call works. A card opens that run on its own: in the Agents panel
 * on desktop, in a sheet on phones.
 */
export default function SubagentsArtifact({ part, directory }: TurnArtifactProps) {
  const status = part.state?.status;
  const isMobile = useUIStore((state) => state.isMobile);
  const [sheetIndex, setSheetIndex] = React.useState<number | null>(null);
  const details = React.useMemo(
    () => parseSubagentDetails(part.state?.metadata, status) ?? (status === 'running' ? runsFromInput(part.state?.input) : null),
    [part.state?.input, part.state?.metadata, status],
  );
  if (!details || details.runs.length === 0) return null;

  const canOpenPanel = !isMobile && Boolean(directory);
  const openPanel = (index: number | null) => {
    if (!directory) return;
    useSubagentSelection.getState().select(index === null ? null : { callId: part.id, index });
    useUIStore.getState().openContextPanelTab(directory, { mode: 'agents' });
  };
  const openRun = canOpenPanel ? openPanel : isMobile ? setSheetIndex : undefined;
  const sheetRun = sheetIndex !== null ? details.runs[sheetIndex] : undefined;

  return (
    <section className="my-3 space-y-2" data-plugin-artifact="subagents" aria-label={MODE_LABEL[details.mode]}>
      <header className="flex min-h-7 items-center gap-2">
        <h3 className="typography-meta font-medium text-foreground">{MODE_LABEL[details.mode]}</h3>
        {details.runs.length > 1 ? (
          <span className="typography-micro text-subtle-foreground">{summarizeRuns(details.runs)}</span>
        ) : null}
        {canOpenPanel ? (
          <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => openPanel(null)}>
            {'Open in panel'}
          </Button>
        ) : null}
      </header>
      <SubagentRunGrid runs={details.runs} onOpen={openRun} />
      {isMobile ? (
        <MobileOverlayPanel
          open={Boolean(sheetRun)}
          title={sheetRun?.agent ?? ''}
          onClose={() => setSheetIndex(null)}
        >
          {sheetRun ? <div className="p-4"><SubagentRunDetail run={sheetRun} /></div> : null}
        </MobileOverlayPanel>
      ) : null}
    </section>
  );
}
