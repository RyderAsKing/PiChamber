import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'ChatInput.tsx'), 'utf8');

test('new-session pending feedback remains active until prompt acceptance settles', () => {
  const sendStart = source.indexOf('const sendPromise = sendMessage(');
  const cleanupStart = source.indexOf('} finally {', sendStart);

  expect(sendStart).toBeGreaterThan(-1);
  expect(cleanupStart).toBeGreaterThan(sendStart);

  const sendLifecycle = source.slice(sendStart, cleanupStart);
  expect(sendLifecycle).toContain('await sendPromise');
  expect(sendLifecycle).toContain('.then(');
  expect(sendLifecycle).not.toContain('void sendPromise.then(');
});
