import React from 'react';

export const useTransientValue = <T,>(initialValue: T, durationMs: number) => {
  const [value, setValue] = React.useState(initialValue);
  const timeoutRef = React.useRef<number | null>(null);

  const cancelReset = React.useCallback(() => {
    if (timeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  React.useEffect(() => cancelReset, [cancelReset]);

  const clear = React.useCallback(() => {
    cancelReset();
    setValue(initialValue);
  }, [cancelReset, initialValue]);

  const show = React.useCallback((nextValue: T) => {
    cancelReset();
    setValue(nextValue);
    if (typeof window === 'undefined') return;
    timeoutRef.current = window.setTimeout(() => {
      setValue(initialValue);
      timeoutRef.current = null;
    }, durationMs);
  }, [cancelReset, durationMs, initialValue]);

  return { value, show, clear } as const;
};
