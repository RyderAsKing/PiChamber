import { FileTypeIcon } from '@/components/icons/FileTypeIcon';

/**
 * File icon that carries upload progress itself: dim and desaturated when
 * empty, lighting up to full color as `progress` reaches 100. Opacity and
 * `saturate()` are composited cheaply, and progress arrives at
 * whole-percentage steps, so each update repaints one 24px icon at most.
 */
const clampUploadProgress = (progress: number | null): number | null =>
  progress === null ? null : Math.min(100, Math.max(0, progress));

export function UploadProgressIcon({
  filename,
  progress,
}: {
  filename: string;
  /** 0-100, or null while the size is indeterminate (e.g. preparing). */
  progress: number | null;
}) {
  const clamped = clampUploadProgress(progress);
  return (
    <span
      role="progressbar"
      aria-label={`Uploading ${filename}`}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(clamped !== null ? { 'aria-valuenow': clamped } : {})}
      className="relative block size-6 shrink-0"
    >
      <span
        className="block size-6"
        style={
          clamped === null
            ? undefined
            : {
                opacity: 0.35 + (0.65 * clamped) / 100,
                filter: `saturate(${clamped / 100})`,
              }
        }
      >
        <FileTypeIcon filePath={filename} className="size-6 shrink-0" />
      </span>
    </span>
  );
}
