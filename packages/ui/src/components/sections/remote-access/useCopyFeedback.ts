import * as React from 'react';

import { copyTextToClipboard } from '@/lib/clipboard';

/** Copy-to-clipboard with transient "copied" feedback. */
export const useCopyFeedback = (): { copied: boolean; copy: (text: string) => void } => {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = React.useCallback((text: string) => {
    void copyTextToClipboard(text).then((result) => {
      if (!result.ok) return;
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  return { copied, copy };
};
