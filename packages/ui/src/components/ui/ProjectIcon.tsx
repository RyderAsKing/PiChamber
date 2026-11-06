import React from 'react';

import { useProjectIconUrl } from '@/lib/projectIcon';
import { getProjectMark } from '@/lib/projectIdentity';
import { cn } from '@/lib/utils';

type ProjectIconProps = {
  /** Project directory used to look up the icon the project ships. */
  directory: string | null | undefined;
  /** Display name; the fallback mark is derived from it. */
  label: string;
  /** Sizing and layout classes. Defaults to `size-4`. */
  className?: string;
};

/**
 * The project's own icon (favicon, app icon, or logo) when it has one,
 * otherwise its first letter on a tint derived from its name.
 */
export function ProjectIcon({ directory, label, className }: ProjectIconProps) {
  const url = useProjectIconUrl(directory);
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);

  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setFailedUrl(url)}
        className={cn('size-4 shrink-0 rounded-[25%] object-contain', className)}
      />
    );
  }

  return <ProjectMark label={label} className={className} />;
}

function ProjectMark({ label, className }: { label: string; className?: string }) {
  const mark = React.useMemo(() => getProjectMark(label), [label]);
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[25%]', className)}
      // The tint lives on the wrapper: global button styles strip fills from
      // SVG rects, which would erase a background drawn inside the SVG.
      style={{ color: mark.color, backgroundColor: `color-mix(in srgb, ${mark.color} 20%, transparent)` }}
    >
      {/* The SVG scales the letter with the box, whatever size the caller sets. */}
      <svg viewBox="0 0 16 16" className="size-full select-none">
        <text x="8" y="11.7" textAnchor="middle" fill="currentColor" fontSize="10.5" fontWeight={700}>
          {mark.text}
        </text>
      </svg>
    </span>
  );
}
