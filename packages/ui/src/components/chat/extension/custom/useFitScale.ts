import * as React from 'react';

/** Smallest scale a surface is drawn at; past it the surface is cropped instead. */
const MIN_SCALE = 0.5;

/**
 * The scale (at most 1) that fits a surface drawn for another device's size
 * into this one. The device driving the size never needs it: the daemon
 * renders at its width.
 */
export const fitScale = (
  natural: { width: number; height?: number },
  available: { width: number; height?: number },
): number => {
  const ratios = [1];
  if (natural.width > 0 && available.width > 0) ratios.push(available.width / natural.width);
  if (natural.height && available.height && natural.height > 0 && available.height > 0) ratios.push(available.height / natural.height);
  return Math.max(MIN_SCALE, Math.min(...ratios));
};

/** A box's inner size and the width of one mono cell in it, kept current. */
export const useBoxMetrics = (
  box: React.RefObject<HTMLElement | null>,
  probe: React.RefObject<HTMLElement | null>,
  /** False while the box is not rendered; measuring starts when it turns true. */
  mounted = true,
): { width: number; height: number; cell: number } => {
  const [metrics, setMetrics] = React.useState({ width: 0, height: 0, cell: 0 });
  React.useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      const cell = (probe.current?.getBoundingClientRect().width ?? 0) / 10;
      setMetrics((previous) => (
        previous.width === width && previous.height === height && previous.cell === cell ? previous : { width, height, cell }
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, probe, mounted]);
  return metrics;
};
