/**
 * Shared attachment preview tooltip content, used by the composer draft
 * cards and the chat message attachment list so both previews stay
 * visually identical. The image mounts only while the owning tooltip is
 * open, so lists never decode attachment bytes by default.
 */
export const attachmentPreviewTooltipContentClassName =
  'p-1.5 max-w-[260px] overflow-hidden rounded-xl bg-popover/95 border border-border shadow-lg';

export interface AttachmentPreviewTooltipContentProps {
  imageUrl?: string;
  filename: string;
  /** Preformatted trailing meta, e.g. `PNG · 24.4 KB`. */
  metaLine?: string;
}

export function AttachmentPreviewTooltipContent({
  imageUrl,
  filename,
  metaLine,
}: AttachmentPreviewTooltipContentProps) {
  if (!imageUrl) {
    return (
      <p>
        {filename}
        {metaLine ? ` (${metaLine})` : ''}
      </p>
    );
  }
  return (
    <div>
      <img
        src={imageUrl}
        alt={filename}
        loading="lazy"
        decoding="async"
        className="max-h-48 w-auto rounded-lg object-contain mx-auto"
      />
      <div className="mt-1 px-1 py-0.5">
        <p className="truncate text-xs font-medium text-foreground">{filename}</p>
        {metaLine ? (
          <p className="text-[11px] text-muted-foreground">{metaLine}</p>
        ) : null}
      </div>
    </div>
  );
}
