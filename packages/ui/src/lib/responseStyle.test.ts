import { expect, mock, test } from 'bun:test';
import type { PiSessionStoreState } from '@/sync/pi-session-store-types';

let requestCount = 0;
let runtimeKey = 'rt-cache';
const runtimeChangeListeners: Array<(detail: { runtimeKey: string; previousRuntimeKey: string }) => void> = [];
let holdFetch: Promise<void> | null = null;

mock.module('./runtime-fetch', () => ({
  runtimeFetch: async () => {
    requestCount += 1;
    if (holdFetch) await holdFetch;
    return new Response(JSON.stringify({
      responseStyleEnabled: true,
      responseStylePreset: 'concise',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
}));

mock.module('./runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (
    callback: (detail: { runtimeKey: string; previousRuntimeKey: string }) => void,
  ) => {
    runtimeChangeListeners.push(callback);
    return () => {
      const index = runtimeChangeListeners.indexOf(callback);
      if (index >= 0) runtimeChangeListeners.splice(index, 1);
    };
  },
}));

const emitRuntimeEndpointChange = (nextKey: string) => {
  const detail = { runtimeKey: nextKey, previousRuntimeKey: runtimeKey };
  runtimeKey = nextKey;
  for (const listener of runtimeChangeListeners) listener(detail);
};

// ---------------------------------------------------------------------------
// First-user-prompt eligibility predicate
// ---------------------------------------------------------------------------

type FixtureRole = 'user' | 'assistant' | 'extension';

const buildStoreState = (options: {
  hydrated?: boolean;
  loadFailed?: boolean;
  resident?: boolean;
  hasMoreBefore?: boolean;
  roles?: FixtureRole[];
}): PiSessionStoreState =>
  ({
    reducer: {
      bySession: new Map(
        options.resident === false
          ? []
          : [[
            's1',
            {
              hasMoreBefore: options.hasMoreBefore ?? false,
              messages: new Map(
                (options.roles ?? []).map((role, index) => [`m${index}`, { role }]),
              ),
            },
          ]],
      ),
      lastSequence: new Map(),
    },
    hydratedSessionIds: new Set(options.hydrated ? ['s1'] : []),
    sessionLoadErrorById: new Map(options.loadFailed ? [['s1', {}]] : []),
  }) as unknown as PiSessionStoreState;

test('an existing session with an earlier user message is not eligible', async () => {
  const { shouldInjectResponseStyle } = await import('./responseStyle');
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: false,
      sessionId: 's1',
      storeState: buildStoreState({ hydrated: true, roles: ['user', 'assistant'] }),
    }),
  ).toBe(false);
});

test('an authoritative fresh empty transcript is eligible', async () => {
  const { shouldInjectResponseStyle } = await import('./responseStyle');
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: false,
      sessionId: 's1',
      storeState: buildStoreState({ hydrated: true, roles: [] }),
    }),
  ).toBe(true);
});

test('an extension-only complete history is eligible', async () => {
  const { shouldInjectResponseStyle } = await import('./responseStyle');
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: false,
      sessionId: 's1',
      storeState: buildStoreState({
        hydrated: true,
        roles: ['extension', 'assistant', 'extension'],
      }),
    }),
  ).toBe(true);
});

test('a user-free paged tail with an older cursor is not proof of a first prompt', async () => {
  const { shouldInjectResponseStyle } = await import('./responseStyle');
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: false,
      sessionId: 's1',
      storeState: buildStoreState({
        hydrated: true,
        roles: ['assistant', 'assistant'],
        hasMoreBefore: true,
      }),
    }),
  ).toBe(false);
});

test('unloaded, failed, and evicted transcripts are not eligible', async () => {
  const { shouldInjectResponseStyle } = await import('./responseStyle');
  // Cold: never hydrated, no resident row.
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: false,
      sessionId: 's1',
      storeState: buildStoreState({ resident: false }),
    }),
  ).toBe(false);
  // Hydration attempt failed: completeness unknown.
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: false,
      sessionId: 's1',
      storeState: buildStoreState({ hydrated: true, loadFailed: true }),
    }),
  ).toBe(false);
  // Evicted transcript: hydrated id without a resident reducer row.
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: false,
      sessionId: 's1',
      storeState: buildStoreState({ hydrated: true, resident: false }),
    }),
  ).toBe(false);
});

test('new-session drafts bypass the transcript predicate', async () => {
  const { shouldInjectResponseStyle } = await import('./responseStyle');
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: true,
      sessionId: null,
      storeState: buildStoreState({ resident: false }),
    }),
  ).toBe(true);
  // A draft still takes precedence even while a stale session id is current.
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: true,
      sessionId: 's1',
      storeState: buildStoreState({ hydrated: true, roles: ['user'] }),
    }),
  ).toBe(true);
  expect(
    shouldInjectResponseStyle({
      newSessionDraftOpen: false,
      sessionId: null,
      storeState: buildStoreState({ hydrated: true }),
    }),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// Runtime-scoped settings snapshot behavior
// ---------------------------------------------------------------------------

test('reuses the response-style snapshot across first-turn sends', async () => {
  const { fetchResponseStyleInstruction } = await import('./responseStyle');
  emitRuntimeEndpointChange('rt-reuse');

  const [first, second] = await Promise.all([
    fetchResponseStyleInstruction(),
    fetchResponseStyleInstruction(),
  ]);
  const third = await fetchResponseStyleInstruction();

  expect(first).toBe(second);
  expect(third).toBe(first);
  expect(requestCount).toBe(1);
});

test('a runtime endpoint switch never reuses a snapshot cached for another runtime', async () => {
  const { fetchResponseStyleInstruction } = await import('./responseStyle');

  emitRuntimeEndpointChange('rt-switched'); // clear any cache from prior tests
  requestCount = 0;
  await fetchResponseStyleInstruction();
  expect(requestCount).toBe(1);

  emitRuntimeEndpointChange('rt-elsewhere');
  await fetchResponseStyleInstruction();
  expect(requestCount).toBe(2);

  // Switching back must not resurrect the pre-switch cached value.
  emitRuntimeEndpointChange('rt-switched');
  await fetchResponseStyleInstruction();
  expect(requestCount).toBe(3);
});

test('an in-flight snapshot resolving after a runtime switch applies and caches nothing', async () => {
  const { fetchResponseStyleInstruction } = await import('./responseStyle');

  emitRuntimeEndpointChange('rt-flight');
  requestCount = 0;
  let releaseFetch: (() => void) | null = null;
  holdFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const pending = fetchResponseStyleInstruction();
  emitRuntimeEndpointChange('rt-elsewhere');
  releaseFetch!();
  expect(await pending).toBeNull();

  // Nothing was cached under the new runtime: the next send fetches again.
  await fetchResponseStyleInstruction();
  expect(requestCount).toBe(2);
  holdFetch = null;
});

// ---------------------------------------------------------------------------
// Send-preparation boundary (consumed by ChatInput handleSubmit)
// ---------------------------------------------------------------------------

test('deferred fetch: an eligible captured session is injected once the awaited settings fetch resolves', async () => {
  const { resolveResponseStyleInstruction } = await import('./responseStyle');

  emitRuntimeEndpointChange('rt-prep');
  requestCount = 0;
  const storeState = buildStoreState({ hydrated: true, roles: [] });

  const instruction = await resolveResponseStyleInstruction({
    newSessionDraftOpen: false,
    sessionId: 's1',
    getStoreState: () => storeState,
  });

  expect(instruction).not.toBeNull();
  expect(requestCount).toBe(1);
});

test('the send-preparation gate skips the settings fetch entirely for an ineligible captured session', async () => {
  const { resolveResponseStyleInstruction } = await import('./responseStyle');

  emitRuntimeEndpointChange('rt-prep-skip');
  requestCount = 0;

  // A transcript with an earlier user message is not a first prompt.
  const instruction = await resolveResponseStyleInstruction({
    newSessionDraftOpen: false,
    sessionId: 's1',
    getStoreState: () => buildStoreState({ hydrated: true, roles: ['user'] }),
  });

  expect(instruction).toBeNull();
  expect(requestCount).toBe(0);
});

test('the view selects another session while the fetch is in flight: the captured target stays eligible and is injected', async () => {
  const { resolveResponseStyleInstruction } = await import('./responseStyle');

  emitRuntimeEndpointChange('rt-prep-switch');
  requestCount = 0;
  // The live store gains a different session (the user selected B) while the
  // captured session A remains authoritatively user-free.
  const selectionState = buildStoreState({ hydrated: true, roles: [] });
  (selectionState.reducer.bySession as Map<string, unknown>).set('s2', {
    hasMoreBefore: false,
    messages: new Map([['m0', { role: 'user' }]]),
  });
  let storeState = buildStoreState({ hydrated: true, roles: [] });
  let releaseFetch: (() => void) | null = null;
  holdFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const pending = resolveResponseStyleInstruction({
    newSessionDraftOpen: false,
    sessionId: 's1',
    getStoreState: () => storeState,
  });
  // The selection lands (fresh state now includes session B) before the
  // settings fetch resolves.
  storeState = selectionState;
  releaseFetch!();

  expect(await pending).not.toBeNull();
  holdFetch = null;
});

test('a first user message commits on the captured session while the fetch is in flight: no double injection', async () => {
  const { resolveResponseStyleInstruction } = await import('./responseStyle');

  emitRuntimeEndpointChange('rt-prep-commit');
  requestCount = 0;
  let storeState = buildStoreState({ hydrated: true, roles: [] });
  let releaseFetch: (() => void) | null = null;
  holdFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const pending = resolveResponseStyleInstruction({
    newSessionDraftOpen: false,
    sessionId: 's1',
    getStoreState: () => storeState,
  });
  // Another send or a remote event commits the first user message on the
  // captured session before the settings fetch resolves.
  storeState = buildStoreState({ hydrated: true, roles: ['user'] });
  releaseFetch!();

  expect(await pending).toBeNull();
  holdFetch = null;
});

test('new-session drafts keep captured draft semantics: no re-check after the fetch', async () => {
  const { resolveResponseStyleInstruction } = await import('./responseStyle');

  emitRuntimeEndpointChange('rt-prep-draft');
  requestCount = 0;
  let storeState = buildStoreState({ hydrated: true, roles: [] });
  let releaseFetch: (() => void) | null = null;
  holdFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const pending = resolveResponseStyleInstruction({
    newSessionDraftOpen: true,
    sessionId: 's1',
    getStoreState: () => storeState,
  });
  // The worktree flow opens a fresh draft mid-send; any transcript change on
  // a stale resident session must not drop the captured draft's injection.
  storeState = buildStoreState({ hydrated: true, roles: ['user'] });
  releaseFetch!();

  expect(await pending).not.toBeNull();
  holdFetch = null;
});

test('a runtime switch while the fetch is in flight yields no instruction for the captured target', async () => {
  const { resolveResponseStyleInstruction } = await import('./responseStyle');

  emitRuntimeEndpointChange('rt-prep-runtime');
  requestCount = 0;
  const storeState = buildStoreState({ hydrated: true, roles: [] });
  let releaseFetch: (() => void) | null = null;
  holdFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const pending = resolveResponseStyleInstruction({
    newSessionDraftOpen: false,
    sessionId: 's1',
    getStoreState: () => storeState,
  });
  // The runtime endpoint switches mid-fetch; the settings snapshot resolves
  // to null for the new runtime, and sendMessage's captured-target guard
  // rejects the dispatch — no instruction can cross runtimes.
  emitRuntimeEndpointChange('rt-prep-elsewhere');
  releaseFetch!();

  expect(await pending).toBeNull();
  holdFetch = null;
});
