import React from 'react';

interface ThemeProviderProps {
  children: React.ReactNode;
}

/** Pi owns its runtime appearance; this preserves the shell provider boundary. */
export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => <>{children}</>;
