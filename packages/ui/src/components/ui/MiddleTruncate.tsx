import React from 'react';

import { splitMiddleTruncation } from '@/lib/middleTruncation';
import { cn } from '@/lib/utils';

/**
 * Cuts the head at its last whole glyph and slides the tail over the gap, so
 * the ellipsis sits flush. Only paint properties change, never layout.
 */
function fitHead(root: HTMLElement, head: HTMLElement, tail: HTMLElement) {
  head.style.clipPath = '';
  tail.style.translate = '';
  root.removeAttribute('data-overflow');
  const text = head.firstChild;
  if (!(text instanceof Text) || head.scrollWidth <= head.clientWidth) return;

  // Showing the ellipsis narrows the head, so measure after it appears.
  root.setAttribute('data-overflow', '');
  const available = head.clientWidth;
  const left = head.getBoundingClientRect().left;
  const range = document.createRange();
  const widthUpTo = (end: number) => {
    range.setStart(text, 0);
    range.setEnd(text, end);
    return range.getBoundingClientRect().right - left;
  };
  let fits = 0;
  let overflows = text.length;
  while (overflows - fits > 1) {
    const middle = (fits + overflows) >> 1;
    if (widthUpTo(middle) <= available) fits = middle;
    else overflows = middle;
  }
  if (/[\uD800-\uDBFF]/.test(text.data[fits - 1] ?? '')) fits -= 1;
  const slack = Math.max(0, available - widthUpTo(fits));
  if (slack > 0) {
    head.style.clipPath = `inset(-0.25em ${slack}px -0.25em 0)`;
    tail.style.translate = `-${slack}px 0`;
  }
}

type MiddleTruncateProps = Omit<React.ComponentProps<'span'>, 'children' | 'title'> & {
  value: string;
  /** Show the full value as a native tooltip. Defaults to true. */
  showTitle?: boolean;
};

/** Single-line text that elides the middle ("pichamber/serv…playwright") instead of the end. */
export function MiddleTruncate({ value, showTitle = true, className, ...props }: MiddleTruncateProps) {
  const split = splitMiddleTruncation(value);
  const rootRef = React.useRef<HTMLSpanElement>(null);
  const headRef = React.useRef<HTMLSpanElement>(null);
  const tailRef = React.useRef<HTMLSpanElement>(null);
  const head = split?.head;

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const headElement = headRef.current;
    const tailElement = tailRef.current;
    if (!root || !headElement || !tailElement || head === undefined) return;
    const refit = () => fitHead(root, headElement, tailElement);
    // A new value can keep the same box size, so fit now, not only on resize.
    refit();
    if (typeof ResizeObserver === 'undefined') return;
    // The root's width comes from its container; the ellipsis toggling inside
    // it never changes that width, so this cannot feed back into itself.
    const observer = new ResizeObserver(refit);
    observer.observe(root);
    return () => observer.disconnect();
  }, [head]);

  return (
    <span
      {...props}
      ref={rootRef}
      title={showTitle ? value : undefined}
      className={cn('group/middle-truncate inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap', className)}
    >
      {split ? (
        <>
          <span ref={headRef} className="min-w-0 overflow-hidden">
            {split.head}
          </span>
          <span ref={tailRef} className="shrink-0">
            <span aria-hidden="true" className="hidden group-data-[overflow]/middle-truncate:inline">
              …
            </span>
            {split.tail}
          </span>
        </>
      ) : (
        // Keyed so React never reuses the clipped head node for the whole value.
        <span key="whole" className="min-w-0 truncate">
          {value}
        </span>
      )}
    </span>
  );
}
