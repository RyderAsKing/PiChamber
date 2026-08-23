import React from 'react';

interface ComposerVoiceVisualizerProps {
  subscribeLevel(listener: (level: number) => void): () => void;
}

const BAR_COUNT = 18;

export function ComposerVoiceVisualizer({ subscribeLevel }: ComposerVoiceVisualizerProps) {
  const barsRef = React.useRef<Array<HTMLSpanElement | null>>([]);
  const frameRef = React.useRef<number | null>(null);
  const levelRef = React.useRef(0);
  const historyRef = React.useRef<number[]>(Array.from({ length: BAR_COUNT }, () => 0.08));

  React.useEffect(() => {
    const paint = () => {
      frameRef.current = null;
      const history = historyRef.current;
      history.shift();
      history.push(Math.max(0.08, levelRef.current));
      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const value = history[index] ?? 0.08;
        bar.style.transform = `scaleY(${value})`;
        bar.style.opacity = String(0.35 + value * 0.65);
      });
    };
    const unsubscribe = subscribeLevel((level) => {
      levelRef.current = level;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(paint);
    });
    return () => {
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [subscribeLevel]);

  return (
    <div className="flex h-12 flex-1 items-center justify-center gap-1" aria-hidden="true">
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <span
          key={index}
          ref={(element) => { barsRef.current[index] = element; }}
          className="h-9 w-1 origin-center rounded-full bg-[var(--primary-base)] opacity-40"
          style={{ transform: 'scaleY(0.08)' }}
        />
      ))}
    </div>
  );
}
