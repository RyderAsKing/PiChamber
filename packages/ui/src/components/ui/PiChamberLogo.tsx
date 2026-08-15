import React, { useMemo } from 'react';
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
        <style>{`@keyframes pc-logo-pulse{0%,100%{opacity:1}50%{opacity:.42}}.pc-logo-pulse{animation:pc-logo-pulse 1.8s ease-in-out infinite}@media (prefers-reduced-motion:reduce){.pc-logo-pulse{animation:none}}`}</style>
      ) : null}

      {/* Three quiet facets form the chamber without competing with the pi mark. */}
      <path d="M50 3 91 27 50 51 9 27Z" fill={foregroundColor} opacity="0.05" />
      <path d="M9 27 50 51V97L9 73Z" fill={foregroundColor} opacity="0.1" />
      <path d="M50 51 91 27V73L50 97Z" fill={foregroundColor} opacity="0.16" />

      <path
        d="M50 3 91 27V73L50 97 9 73V27Z"
        stroke={foregroundColor}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* A geometric pi bridges the open top and the chamber below. */}
      <path
        className={isAnimated ? 'pc-logo-pulse' : undefined}
        d="M28 31H72 M38 31V68 M62 31V55C62 64 67 68 75 68"
        stroke={foregroundColor}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
