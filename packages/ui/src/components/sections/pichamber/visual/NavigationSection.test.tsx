import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';
import { NavigationSection } from './NavigationSection';

const noop = () => undefined;

const render = (sidebarViewMode: SidebarViewMode): string => renderToStaticMarkup(
  <TooltipProvider>
    <NavigationSection
      shouldShow={(setting) => setting === 'sidebarViewMode'}
      sidebarViewMode={sidebarViewMode}
      onSidebarViewModeChange={noop}
      fileEditorKeymap="default"
      setFileEditorKeymap={noop}
      autoSaveEnabled={false}
      setAutoSaveEnabled={noop}
      expandedEditorToolbar={false}
      onExpandedEditorToolbarChange={noop}
      wrapLinesByDefault={false}
      onWrapLinesByDefaultChange={noop}
      showTerminalQuickKeysOnDesktop={false}
      setShowTerminalQuickKeysOnDesktop={noop}
      showTerminalShellSetting={false}
      terminalShell=""
      setTerminalShell={noop}
      terminalShellOptions={[]}
      terminalShellSupportsLogin={false}
      terminalLoginShellEnabled={false}
      setTerminalLoginShellEnabled={noop}
    />
  </TooltipProvider>,
);

const legacyPart = (markup: string): string => markup.slice(markup.indexOf('<details'), markup.indexOf('</details>'));

describe('Sidebar view setting', () => {
  test('Timeline sits under a closed Legacy views disclosure while another view is selected', () => {
    const markup = render('threads');
    const beforeLegacy = markup.slice(0, markup.indexOf('<details'));
    for (const label of ['Workspace', 'By folder', 'Threads']) expect(beforeLegacy).toContain(`aria-label="${label}"`);
    expect(beforeLegacy).not.toContain('aria-label="Timeline"');
    expect(legacyPart(markup)).toContain('Legacy views');
    expect(legacyPart(markup)).toContain('aria-label="Timeline"');
    expect(markup).not.toContain('<details open');
  });

  test('Legacy views starts open when Timeline is the current view', () => {
    const markup = render('timeline');
    expect(markup).toContain('<details open');
    expect(legacyPart(markup)).toContain('aria-checked="true" aria-label="Timeline"');
  });
});
