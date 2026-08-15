import React, { useMemo, useId } from 'react';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';

interface PiChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

export const PiChamberLogo: React.FC<PiChamberLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
}) => {
  const themeContext = useOptionalThemeSystem();
  const rawId = useId();
  const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const maskId = `pc-shimmer-mask-${cleanId}`;
  const gradId = `pc-shimmer-grad-${cleanId}`;

  const foregroundColor = useMemo(() => {
    if (themeContext) {
      return themeContext.currentTheme.colors.surface.foreground;
    }
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-stroke').trim();
      if (fromVars) {
        return fromVars;
      }
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'white' : 'black';
    }
    return 'white';
  }, [themeContext]);

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={"PiChamber logo"}
    >
      {isAnimated ? (
        <>
          <defs>
            <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
              <stop offset="0%" stopColor={foregroundColor} stopOpacity="0" />
              <stop offset="35%" stopColor={foregroundColor} stopOpacity="0" />
              <stop offset="50%" stopColor={foregroundColor} stopOpacity="1" />
              <stop offset="65%" stopColor={foregroundColor} stopOpacity="0" />
              <stop offset="100%" stopColor={foregroundColor} stopOpacity="0" />
            </linearGradient>
            <mask id={maskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
              <g fill="none">
                <path d="M50 3 91 27 50 51 9 27Z" fill="white" opacity="0.3" />
                <path d="M9 27 50 51V97L9 73Z" fill="white" opacity="0.55" />
                <path d="M50 51 91 27V73L50 97Z" fill="white" opacity="0.85" />
                <path
                  d="M50 3 91 27V73L50 97 9 73V27Z"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M28 31H72 M38 31V68 M62 31V55C62 64 67 68 75 68"
                  stroke="white"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            </mask>
          </defs>
          <style>{`@keyframes pc-shimmer-anim{0%{transform:translate(-110px,-110px)}100%{transform:translate(110px,110px)}}.pc-shimmer-sweep{animation:pc-shimmer-anim 1.8s cubic-bezier(0.4,0,0.2,1) infinite}@media (prefers-reduced-motion:reduce){.pc-shimmer-sweep{animation:none}}`}</style>
        </>
      ) : null}

      {/* Three quiet facets form the chamber with subtle depth */}
      <path d="M50 3 91 27 50 51 9 27Z" fill={foregroundColor} opacity={isAnimated ? 0.04 : 0.08} />
      <path d="M9 27 50 51V97L9 73Z" fill={foregroundColor} opacity={isAnimated ? 0.08 : 0.14} />
      <path d="M50 51 91 27V73L50 97Z" fill={foregroundColor} opacity={isAnimated ? 0.13 : 0.22} />

      <path
        d="M50 3 91 27V73L50 97 9 73V27Z"
        stroke={foregroundColor}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={isAnimated ? 0.6 : 1}
      />

      {/* A geometric pi bridges the open top and the chamber below. */}
      <path
        d="M28 31H72 M38 31V68 M62 31V55C62 64 67 68 75 68"
        stroke={foregroundColor}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={isAnimated ? 0.75 : 1}
      />

      {isAnimated ? (
        <g mask={`url(#${maskId})`}>
          <rect
            x="-50"
            y="-50"
            width="200"
            height="200"
            fill={`url(#${gradId})`}
            className="pc-shimmer-sweep"
          />
        </g>
      ) : null}
    </svg>
  );
};
