import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsPreviewOption } from '@/components/sections/shared/SettingsSection';
import { SidebarViewPreview } from './SidebarViewPreview';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';

describe('SidebarViewPreview', () => {
  const modes: SidebarViewMode[] = ['workspace', 'folder', 'timeline'];

  test('each mode renders data-sidebar-view-preview="<mode>"', () => {
    for (const mode of modes) {
      const markup = renderToStaticMarkup(React.createElement(SidebarViewPreview, { mode }));
      expect(markup).toContain(`data-sidebar-view-preview="${mode}"`);
    }
  });

  test('the three modes produce three different markups', () => {
    const markups = modes.map((mode) =>
      renderToStaticMarkup(React.createElement(SidebarViewPreview, { mode })),
    );

    expect(markups[0]).not.toBe(markups[1]);
    expect(markups[0]).not.toBe(markups[2]);
    expect(markups[1]).not.toBe(markups[2]);
  });

  test('the markup contains no scaled spacing utility', () => {
    const scaledSpacingPattern = /\b(?:p|px|py|pl|pr|m|mx|my|ml|mr|gap|h|w)-\d/;
    for (const mode of modes) {
      const markup = renderToStaticMarkup(React.createElement(SidebarViewPreview, { mode }));
      expect(scaledSpacingPattern.test(markup)).toBe(false);
    }
  });

  test('SettingsPreviewOption selected true/false states and aria attributes', () => {
    const previewChild = React.createElement('div', { 'data-testid': 'custom-preview' }, 'preview content');

    const markupSelected = renderToStaticMarkup(
      React.createElement(SettingsPreviewOption, {
        selected: true,
        onSelect: () => undefined,
        label: 'Workspace',
        ariaLabel: 'Workspace',
        preview: previewChild,
      }),
    );

    // The tile is the only radio: the dot inside it is decorative, so each
    // option is one tab stop and one announced control.
    expect(markupSelected.match(/role="radio"/g)).toHaveLength(1);
    expect(markupSelected).not.toContain('aria-pressed');
    expect(markupSelected).toContain('aria-checked="true"');
    expect(markupSelected).toContain('aria-label="Workspace"');
    expect(/<button[^>]*aria-hidden="true"[^>]*tabindex="-1"/.test(markupSelected)).toBe(true);
    expect(markupSelected).toContain('data-testid="custom-preview"');
    expect(markupSelected).toContain('aria-hidden="true"');

    const markupUnselected = renderToStaticMarkup(
      React.createElement(SettingsPreviewOption, {
        selected: false,
        onSelect: () => undefined,
        label: 'Workspace',
        ariaLabel: 'Workspace',
        preview: previewChild,
      }),
    );

    expect(markupUnselected).not.toContain('aria-pressed');
    expect(markupUnselected).toContain('aria-checked="false"');
  });
});
