import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'ModelControls.tsx'), 'utf8');

// Static topology guard only: the historical transcript fallback subscription
// was deleted. It does not prove restore behavior at runtime; the
// authoritative-composer classifier behavior remains covered by
// model-selection-sync.test.ts.
describe('ModelControls restore without historical transcript fallback', () => {
  test('removes the disabled transcript subscription without adding a new one', () => {
    expect(source).not.toContain('useSessionMessages');
    expect(source).not.toContain('getSyncParts');
    expect(source).not.toContain('findLatestUserModelChoice');
    expect(source).not.toContain('latestLoadedUserChoice');
    expect(source).not.toContain('currentSessionMessagesFromSync');
    expect(source).not.toContain('historicalVariant');
    // Live Pi snapshot + renderability remain the only session subscriptions.
    expect(source).toContain('useSessionRenderable');
    expect(source).toContain('usePiSessionSnapshot');
  });
});
