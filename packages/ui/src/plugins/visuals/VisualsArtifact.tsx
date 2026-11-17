import type { TurnArtifactProps } from '@/plugins/types';
import { parseVisualDetails } from './document';
import { useAllowNetwork } from './useAllowNetwork';
import { VisualDrawing, VisualFrame } from './VisualFrame';

/**
 * `render_html` call: a drawing placeholder while it is written, then the
 * page. Drawn for any finished call whose details
 * have the Visuals shape, also after the plugin was turned off: the page is
 * part of the session.
 */
export default function VisualsArtifact({ part, directory }: TurnArtifactProps) {
  const allowNetwork = useAllowNetwork(directory);
  const status = part.state?.status;
  if (status === 'pending' || status === 'running') {
    const input = (part.state?.input ?? {}) as { title?: unknown; html?: unknown };
    return (
      <VisualDrawing
        title={typeof input.title === 'string' ? input.title : undefined}
        size={typeof input.html === 'string' ? input.html.length : 0}
      />
    );
  }
  if (status !== 'completed') return null;
  const details = parseVisualDetails(part.state?.metadata);
  if (!details) return null;
  return <VisualFrame details={details} allowNetwork={allowNetwork} />;
}
