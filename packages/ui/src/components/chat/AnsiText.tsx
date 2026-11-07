import * as React from 'react';
import { containsAnsiEscape, parseAnsiSegments, renderSegmentStyle, safeHyperlink, type AnsiSegment } from '@/lib/pi/ansi';

export interface AnsiTextProps {
  text?: string | null;
  className?: string;
  style?: React.CSSProperties;
  /** Render OSC 8 hyperlinks (http and https only) as links. */
  links?: boolean;
}

const ANSI_LINK_CLASS = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';

/** An OSC 8 hyperlink segment as a link that opens in a new tab. */
export const AnsiLink: React.FC<{ segment: AnsiSegment; href: string; children: React.ReactNode }> = ({ segment, href, children }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className={ANSI_LINK_CLASS}
    style={renderSegmentStyle(segment)}
  >
    {children}
  </a>
);

/**
 * Renders ANSI SGR-formatted text as structured React spans with semantic CSS variables.
 * Plain text without escape sequences renders directly with zero styling overhead.
 */
export const AnsiText: React.FC<AnsiTextProps> = React.memo(({ text, className, style, links = false }) => {
  if (text === undefined || text === null || text === '') {
    return null;
  }

  if (!containsAnsiEscape(text)) {
    if (className || style) {
      return <span className={className} style={style}>{text}</span>;
    }
    return <>{text}</>;
  }

  const segments = parseAnsiSegments(text);
  if (segments.length === 0) {
    return null;
  }

  if (segments.length === 1 && !renderSegmentStyle(segments[0]!) && !(links && segments[0]!.href)) {
    if (className || style) {
      return <span className={className} style={style}>{segments[0]!.text}</span>;
    }
    return <>{segments[0]!.text}</>;
  }

  return (
    <span className={className} style={style}>
      {segments.map((seg, idx) => {
        const href = links ? safeHyperlink(seg.href) : undefined;
        if (href) {
          return <AnsiLink key={idx} segment={seg} href={href}>{seg.text}</AnsiLink>;
        }
        const segStyle = renderSegmentStyle(seg);
        if (!segStyle) {
          return <React.Fragment key={idx}>{seg.text}</React.Fragment>;
        }
        return (
          <span key={idx} style={segStyle}>
            {seg.text}
          </span>
        );
      })}
    </span>
  );
});

AnsiText.displayName = 'AnsiText';
