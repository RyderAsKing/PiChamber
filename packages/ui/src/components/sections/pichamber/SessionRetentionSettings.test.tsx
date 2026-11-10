import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ArchiveAndDeleteFields, SessionRetentionSettings } from './SessionRetentionSettings';

const noop = () => undefined;

const render = (archive: number, remove: number): string => renderToStaticMarkup(
  <TooltipProvider>
    <ArchiveAndDeleteFields
      archiveAfterDays={archive}
      deleteAfterDays={remove}
      onArchiveAfterDaysChange={noop}
      onDeleteAfterDaysChange={noop}
    />
  </TooltipProvider>,
);

const SUGGESTION = 'Suggested: 7 days, so the sidebar shows what you&#x27;re working on.';

describe('Archive and delete settings', () => {
  test('suggests turning auto-archive on only while it is off', () => {
    const off = render(0, 0);
    expect(off).toContain(SUGGESTION);
    expect(off).toContain('>Turn on</button>');

    const on = render(7, 0);
    expect(on).not.toContain(SUGGESTION);
    expect(on).not.toContain('>Turn on</button>');
  });

  test('the delete warning shows only while auto-delete is on', () => {
    expect(render(7, 0)).not.toContain('Deleted sessions can&#x27;t be restored.');
    const on = render(7, 30);
    expect(on).toContain('Deleted sessions can&#x27;t be restored.');
    expect(on).toContain('days after archiving');
    expect(on).toContain('value="30"');
  });

  test('every control carries its settings search anchor', () => {
    const markup = renderToStaticMarkup(<TooltipProvider><SessionRetentionSettings /></TooltipProvider>);
    for (const id of ['sessions.auto-archive', 'sessions.auto-delete', 'sessions.auto-cleanup']) {
      expect(markup).toContain(`data-settings-item="${id}"`);
    }
  });
});
