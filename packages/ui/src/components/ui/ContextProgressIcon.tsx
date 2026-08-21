/* eslint-disable react-refresh/only-export-components */
import React from 'react';

export const clampContextPercent = (value: number | null): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
};

export const resolveContextUsageTone = (pct: number): 'safe' | 'warn' | 'critical' => {
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warn';
  return 'safe';
};

export const ContextProgressIcon: React.FC<{
  percentage: number;
  size?: number;
  stroke?: number;
  className?: string;
}> = ({ percentage, size = 18, stroke = 3, className }) => {
  const progressPct = clampContextPercent(percentage);
  const tone = resolveContextUsageTone(percentage);
  const progressColor =
    tone === 'critical'
      ? 'var(--status-error)'
      : tone === 'warn'
        ? 'var(--status-warning)'
        : 'var(--status-success)';
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={className ?? 'size-[18px] -rotate-90'}
      role="progressbar"
      aria-valuenow={Math.round(progressPct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--interactive-border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={progressColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progressPct / 100)}
        className="transition-[stroke-dashoffset,stroke] duration-300"
      />
    </svg>
  );
};
