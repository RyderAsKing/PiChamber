import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'BackgroundTasksMenu.tsx'), 'utf8');

test('each Restore draft button has a task-identifying accessible name with unchanged visible copy', () => {
  // Visible copy stays short; screen readers need the owning task when several
  // failed rows render identical buttons — including concurrent normal
  // draft-ID-keyed rows that share source directory and start ref.
  expect(source).toContain(
    'aria-label={`Restore draft for ${entry.intent.sourceDirectory} from ${entry.intent.startRef} (task ${shortWorktreeTaskId(entry.key)})`}',
  );
  // No conditional omission: the old intent-key branch dropped the identifier.
  expect(source).not.toContain("startsWith('[')");
  // The button children (visible copy) must remain exactly "Restore draft".
  expect(/>\s*Restore draft\s*<\/Button>/.test(source)).toBe(true);
});

test('prompt-dispatch-pending rows count as active so the header never reports zero while Sending prompt spins', () => {
  // A prompt-dispatch-pending entry (receipt && failedSend && !state) has no
  // lifecycle state, so a state-only active count would report `0 worktrees
  // are being created` while its row still spins as `Sending prompt...`.
  const activeCountSource = source.match(/const activeCount =[\s\S]*?\.length;/)?.[0];
  expect(activeCountSource).toContain('isWorktreePromptPending(entry)');
  // Singular/plural header copy is preserved.
  expect(source).toContain('1 worktree is being created');
  expect(source).toContain('worktrees are being created');
});
