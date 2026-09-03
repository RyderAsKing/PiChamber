import { expect, mock, test } from 'bun:test';

let requestCount = 0;
mock.module('./runtime-fetch', () => ({
  runtimeFetch: async () => {
    requestCount += 1;
    return new Response(JSON.stringify({
      responseStyleEnabled: true,
      responseStylePreset: 'concise',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
}));

test('reuses the response-style snapshot across first-turn sends', async () => {
  const { fetchResponseStyleInstruction } = await import('./responseStyle');

  const [first, second] = await Promise.all([
    fetchResponseStyleInstruction(),
    fetchResponseStyleInstruction(),
  ]);
  const third = await fetchResponseStyleInstruction();

  expect(first).toBe(second);
  expect(third).toBe(first);
  expect(requestCount).toBe(1);
});
