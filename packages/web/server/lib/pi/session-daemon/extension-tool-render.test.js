import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExtensionTheme } from './extension-theme.js';
import {
  MAX_TOOL_RENDER_LINES,
  MAX_TOOL_RENDER_LINE_CHARS,
  TOOL_RENDER_THROTTLE_MS,
  TOOL_RENDER_WIDTH,
  createExtensionToolRenderer,
  installExtensionGlobalTheme,
} from './extension-tool-render.js';

describe('extension-tool-render', () => {
  const THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme');
  const THEME_KEY_OLD = Symbol.for('@mariozechner/pi-coding-agent:theme');
  let originalTheme;
  let originalThemeOld;

  beforeEach(() => {
    originalTheme = globalThis[THEME_KEY];
    originalThemeOld = globalThis[THEME_KEY_OLD];
  });

  afterEach(() => {
    if (originalTheme !== undefined) {
      globalThis[THEME_KEY] = originalTheme;
    } else {
      delete globalThis[THEME_KEY];
    }
    if (originalThemeOld !== undefined) {
      globalThis[THEME_KEY_OLD] = originalThemeOld;
    } else {
      delete globalThis[THEME_KEY_OLD];
    }
  });

  describe('installExtensionGlobalTheme', () => {
    it('installs theme on both symbols when primary is unset', () => {
      delete globalThis[THEME_KEY];
      delete globalThis[THEME_KEY_OLD];
      const theme = { name: 'test-theme' };
      installExtensionGlobalTheme(theme);
      expect(globalThis[THEME_KEY]).toBe(theme);
      expect(globalThis[THEME_KEY_OLD]).toBe(theme);
    });

    it('does not override an existing theme on the primary symbol', () => {
      const existing = { name: 'existing-theme' };
      globalThis[THEME_KEY] = existing;
      globalThis[THEME_KEY_OLD] = existing;
      const newTheme = { name: 'new-theme' };
      installExtensionGlobalTheme(newTheme);
      expect(globalThis[THEME_KEY]).toBe(existing);
      expect(globalThis[THEME_KEY_OLD]).toBe(existing);
    });
  });

  describe('resolve', () => {
    it('returns definition when session extensionRunner has renderCall or renderResult', () => {
      const renderer = createExtensionToolRenderer({ theme: createExtensionTheme() });
      const toolDefWithCall = {
        renderCall: vi.fn(),
      };
      const toolDefWithResult = {
        renderResult: vi.fn(),
      };
      const session = {
        extensionRunner: {
          getToolDefinition: (name) => {
            if (name === 'withCall') return toolDefWithCall;
            if (name === 'withResult') return toolDefWithResult;
            return undefined;
          },
        },
      };

      expect(renderer.resolve(session, 'withCall')).toBe(toolDefWithCall);
      expect(renderer.resolve(session, 'withResult')).toBe(toolDefWithResult);
      expect(renderer.resolve(session, 'builtinTool')).toBeUndefined();
    });

    it('returns undefined when getToolDefinition throws or returns non-renderable object', () => {
      const renderer = createExtensionToolRenderer({ theme: createExtensionTheme() });
      const session = {
        extensionRunner: {
          getToolDefinition: (name) => {
            if (name === 'throwing') throw new Error('boom');
            if (name === 'empty') return {};
            return null;
          },
        },
      };

      expect(renderer.resolve(session, 'throwing')).toBeUndefined();
      expect(renderer.resolve(session, 'empty')).toBeUndefined();
      expect(renderer.resolve(session, 'null')).toBeUndefined();
      expect(renderer.resolve(undefined, 'any')).toBeUndefined();
    });
  });

  describe('rendering and sanitization', () => {
    it('passes standard ToolRenderContext and width to component.render', () => {
      const theme = createExtensionTheme();
      const renderer = createExtensionToolRenderer({ theme });
      let capturedCallContext;
      let capturedCallWidth;
      let capturedResultContext;
      let capturedResultWidth;

      const definition = {
        renderCall: vi.fn((args, th, ctx) => {
          capturedCallContext = ctx;
          return {
            render: (w) => {
              capturedCallWidth = w;
              return ['call line'];
            },
          };
        }),
        renderResult: vi.fn((result, opts, th, ctx) => {
          capturedResultContext = ctx;
          return {
            render: (w) => {
              capturedResultWidth = w;
              return ['result line'];
            },
          };
        }),
      };

      const render = renderer.onStart({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: { query: 'test' },
        cwd: '/work',
      });

      expect(render).toEqual({ call: ['call line'] });
      expect(capturedCallWidth).toBe(TOOL_RENDER_WIDTH);
      expect(capturedCallContext.args).toEqual({ query: 'test' });
      expect(capturedCallContext.toolCallId).toBe('t1');
      expect(capturedCallContext.cwd).toBe('/work');
      expect(capturedCallContext.executionStarted).toBe(true);
      expect(capturedCallContext.argsComplete).toBe(true);
      expect(capturedCallContext.showImages).toBe(false);
      expect(typeof capturedCallContext.invalidate).toBe('function');
      expect(capturedCallContext.state).toEqual({});

      const endRender = renderer.onEnd({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: { query: 'test' },
        cwd: '/work',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false,
      });

      expect(endRender).toEqual({
        call: ['call line'],
        result: ['result line'],
        resultExpanded: ['result line'],
      });
      expect(capturedResultWidth).toBe(TOOL_RENDER_WIDTH);
      expect(capturedResultContext.isError).toBe(false);
      expect(capturedResultContext.isPartial).toBe(false);
    });

    it('gives renderCall and renderResult key hints without terminal keys', () => {
      const theme = createExtensionTheme();
      const renderer = createExtensionToolRenderer({ theme });
      const strip = (lines) => lines?.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));

      const definition = {
        renderCall: (_args, _th, ctx) => ({ render: () => [`call [${ctx.keyText('app.tools.expand')}]`] }),
        renderResult: (_result, opts, _th, ctx) => ({
          render: () => [ctx.keyHint('app.tools.expand', opts.expanded ? 'to collapse' : 'to expand')],
        }),
      };

      const render = renderer.renderSettled(definition, {
        toolCallId: 't1',
        args: {},
        cwd: '/work',
        result: { content: [] },
        isError: false,
      });

      expect(render.call).toEqual(['call []']);
      expect(strip(render.result)).toEqual(['to expand']);
      expect(strip(render.resultExpanded)).toEqual(['to collapse']);
      expect(render.result[0]).toBe(theme.fg('muted', 'to expand'));
    });

    it('sanitizes line counts and line lengths', () => {
      const renderer = createExtensionToolRenderer({ theme: createExtensionTheme() });
      const longLine = 'x'.repeat(MAX_TOOL_RENDER_LINE_CHARS + 500);
      const manyLines = Array.from({ length: MAX_TOOL_RENDER_LINES + 50 }, (_, i) => `line ${i}`);

      const definition = {
        renderCall: () => ({
          render: () => [longLine],
        }),
        renderResult: () => ({
          render: () => manyLines,
        }),
      };

      const start = renderer.onStart({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: {},
        cwd: '/',
      });
      expect(start.call).toHaveLength(1);
      expect(start.call[0]).toHaveLength(MAX_TOOL_RENDER_LINE_CHARS);

      const end = renderer.onEnd({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: {},
        cwd: '/',
        result: {},
        isError: false,
      });
      expect(end.result).toHaveLength(MAX_TOOL_RENDER_LINES);
    });

    it('returns undefined when renderer throws or returns non-renderable object without throwing out of module', () => {
      const renderer = createExtensionToolRenderer({ theme: createExtensionTheme() });
      const throwingDef = {
        renderCall: () => {
          throw new Error('render error');
        },
        renderResult: () => ({
          render: () => {
            throw new Error('render method error');
          },
        }),
      };

      expect(() => {
        const start = renderer.onStart({
          sessionId: 's1',
          toolCallId: 't1',
          definition: throwingDef,
          args: {},
          cwd: '/',
        });
        expect(start).toBeUndefined();

        const end = renderer.onEnd({
          sessionId: 's1',
          toolCallId: 't1',
          definition: throwingDef,
          args: {},
          cwd: '/',
          result: {},
          isError: false,
        });
        expect(end).toBeUndefined();
      }).not.toThrow();
    });

    it('returns undefined when component.render returns empty array or non-array', () => {
      const renderer = createExtensionToolRenderer({ theme: createExtensionTheme() });
      const emptyDef = {
        renderCall: () => ({
          render: () => [],
        }),
        renderResult: () => ({
          render: () => 'not an array',
        }),
      };

      const start = renderer.onStart({
        sessionId: 's1',
        toolCallId: 't1',
        definition: emptyDef,
        args: {},
        cwd: '/',
      });
      expect(start).toBeUndefined();

      const end = renderer.onEnd({
        sessionId: 's1',
        toolCallId: 't1',
        definition: emptyDef,
        args: {},
        cwd: '/',
        result: {},
        isError: false,
      });
      expect(end).toBeUndefined();
    });
  });

  describe('throttling and trailing publish', () => {
    it('throttles partial updates and emits trailing update when timer fires', () => {
      let currentTime = 1000;
      const scheduledTasks = new Map();
      let timerIdCounter = 1;

      const fakeSchedule = (fn, delay) => {
        const id = timerIdCounter++;
        scheduledTasks.set(id, { fn, triggerAt: currentTime + delay });
        return id;
      };
      const fakeCancel = (id) => {
        scheduledTasks.delete(id);
      };
      const fakeNow = () => currentTime;

      const advanceTimers = (ms) => {
        currentTime += ms;
        for (const [id, task] of [...scheduledTasks.entries()]) {
          if (currentTime >= task.triggerAt) {
            scheduledTasks.delete(id);
            task.fn();
          }
        }
      };

      const renderer = createExtensionToolRenderer({
        theme: createExtensionTheme(),
        schedule: fakeSchedule,
        cancel: fakeCancel,
        now: fakeNow,
      });

      let callCounter = 0;
      let resultCounter = 0;
      const definition = {
        renderCall: () => {
          callCounter += 1;
          return { render: () => [`call v${callCounter}`] };
        },
        renderResult: (res) => {
          resultCounter += 1;
          return { render: () => [`result v${resultCounter}: ${res?.step}`] };
        },
      };

      const publishMock = vi.fn();

      // First update at t=1000 -> immediate render
      const first = renderer.onUpdate({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: {},
        cwd: '/',
        partialResult: { step: 1 },
        publish: publishMock,
      });

      expect(first).toEqual({
        call: ['call v1'],
        result: ['result v1: 1'],
        resultExpanded: ['result v2: 1'],
      });
      expect(publishMock).not.toHaveBeenCalled();

      // Second update at t=1050 (< 250ms) -> throttled (returns undefined, arms trailing timer)
      currentTime = 1050;
      const second = renderer.onUpdate({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: {},
        cwd: '/',
        partialResult: { step: 2 },
        publish: publishMock,
      });

      expect(second).toBeUndefined();
      expect(scheduledTasks.size).toBe(1);
      expect(publishMock).not.toHaveBeenCalled();

      // Third update at t=1100 (< 250ms) -> updates latest, reuses armed timer
      currentTime = 1100;
      const third = renderer.onUpdate({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: {},
        cwd: '/',
        partialResult: { step: 3 },
        publish: publishMock,
      });

      expect(third).toBeUndefined();
      expect(scheduledTasks.size).toBe(1);
      expect(publishMock).not.toHaveBeenCalled();

      // Advance time past 250ms window (e.g. t=1300)
      advanceTimers(200);

      expect(publishMock).toHaveBeenCalledTimes(1);
      expect(publishMock).toHaveBeenCalledWith({
        call: ['call v1'], // Call output was cached
        result: ['result v3: 3'],
        resultExpanded: ['result v4: 3'],
      });
    });

    it('arms trailing timer when context.invalidate is called', () => {
      let currentTime = 1000;
      const scheduledTasks = new Map();
      let timerIdCounter = 1;

      const fakeSchedule = (fn, delay) => {
        const id = timerIdCounter++;
        scheduledTasks.set(id, { fn, triggerAt: currentTime + delay });
        return id;
      };
      const fakeCancel = (id) => {
        scheduledTasks.delete(id);
      };
      const fakeNow = () => currentTime;

      const advanceTimers = (ms) => {
        currentTime += ms;
        for (const [id, task] of [...scheduledTasks.entries()]) {
          if (currentTime >= task.triggerAt) {
            scheduledTasks.delete(id);
            task.fn();
          }
        }
      };

      const renderer = createExtensionToolRenderer({
        theme: createExtensionTheme(),
        schedule: fakeSchedule,
        cancel: fakeCancel,
        now: fakeNow,
      });

      let savedContext;
      let renderCount = 0;
      const definition = {
        renderCall: vi.fn(),
        renderResult: (res, opts, th, ctx) => {
          savedContext = ctx;
          renderCount += 1;
          return { render: () => [`render count ${renderCount}`] };
        },
      };

      const publishMock = vi.fn();

      renderer.onUpdate({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: {},
        cwd: '/',
        partialResult: { data: 'initial' },
        publish: publishMock,
      });

      // Partial updates render both the collapsed and expanded slots.
      expect(renderCount).toBe(2);

      // Now component calls invalidate()
      savedContext.invalidate();
      expect(scheduledTasks.size).toBe(1);

      // Advance time to trigger trailing publish
      advanceTimers(TOOL_RENDER_THROTTLE_MS + 10);

      expect(publishMock).toHaveBeenCalledTimes(1);
      expect(publishMock).toHaveBeenCalledWith({
        result: ['render count 3'],
        resultExpanded: ['render count 4'],
      });
    });
  });

  describe('getLiveRender', () => {
    it('tracks the latest published render until the tool ends or the session clears', () => {
      let currentTime = 1000;
      const renderer = createExtensionToolRenderer({
        theme: createExtensionTheme(),
        schedule: () => 1,
        cancel: () => {},
        now: () => currentTime,
      });
      const definition = {
        renderCall: () => ({ render: () => ['call'] }),
        renderResult: (res, { expanded }) => ({ render: () => [`${res.step}:${expanded}`] }),
      };
      const base = { sessionId: 's1', toolCallId: 't1', definition, args: {}, cwd: '/' };

      expect(renderer.getLiveRender('s1', 't1')).toBeUndefined();
      renderer.onStart(base);
      expect(renderer.getLiveRender('s1', 't1')).toEqual({ call: ['call'] });

      currentTime = 2000;
      renderer.onUpdate({ ...base, partialResult: { step: 1 }, publish: () => {} });
      expect(renderer.getLiveRender('s1', 't1')).toEqual({ call: ['call'], result: ['1:false'], resultExpanded: ['1:true'] });

      renderer.onEnd({ ...base, result: { step: 2 }, isError: false });
      expect(renderer.getLiveRender('s1', 't1')).toBeUndefined();

      renderer.onStart({ ...base, toolCallId: 't2' });
      renderer.clearSession('s1');
      expect(renderer.getLiveRender('s1', 't2')).toBeUndefined();
    });
  });

  describe('renderSettled and memoization', () => {
    it('memoizes settled render by result object via WeakMap', () => {
      const renderer = createExtensionToolRenderer({ theme: createExtensionTheme() });
      let callCount = 0;
      let resultCount = 0;

      const definition = {
        renderCall: () => {
          callCount += 1;
          return { render: () => ['call output'] };
        },
        renderResult: () => {
          resultCount += 1;
          return { render: () => ['result output'] };
        },
      };

      const resultObj = { role: 'toolResult', content: [{ type: 'text', text: 'hello' }] };

      const first = renderer.renderSettled(definition, {
        toolCallId: 't1',
        args: { a: 1 },
        cwd: '/test',
        result: resultObj,
        isError: false,
      });

      expect(first).toEqual({
        call: ['call output'],
        result: ['result output'],
        resultExpanded: ['result output'],
      });
      expect(callCount).toBe(1);
      expect(resultCount).toBe(2); // collapsed + expanded

      // Calling again with the same result object should return memoized result
      const second = renderer.renderSettled(definition, {
        toolCallId: 't1',
        args: { a: 1 },
        cwd: '/test',
        result: resultObj,
        isError: false,
      });

      expect(second).toBe(first);
      expect(callCount).toBe(1);
      expect(resultCount).toBe(2);
    });
  });

  describe('clearSession and dispose', () => {
    it('cancels timers and clears entries for a specific session', () => {
      let cancelledTimerId = null;
      const renderer = createExtensionToolRenderer({
        theme: createExtensionTheme(),
        schedule: () => 999,
        cancel: (id) => {
          cancelledTimerId = id;
        },
        now: () => 1000,
      });

      const definition = {
        renderCall: vi.fn(),
        renderResult: () => ({ render: () => ['line'] }),
      };

      // Put session into throttled state
      renderer.onUpdate({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: {},
        cwd: '/',
        partialResult: {},
        publish: vi.fn(),
      });
      // Second update at same time triggers timer
      renderer.onUpdate({
        sessionId: 's1',
        toolCallId: 't1',
        definition,
        args: {},
        cwd: '/',
        partialResult: {},
        publish: vi.fn(),
      });

      renderer.clearSession('s1');
      expect(cancelledTimerId).toBe(999);
    });

    it('cancels all timers and clears all entries on dispose', () => {
      const cancelledTimers = [];
      let timerId = 1;
      const renderer = createExtensionToolRenderer({
        theme: createExtensionTheme(),
        schedule: () => timerId++,
        cancel: (id) => cancelledTimers.push(id),
        now: () => 1000,
      });

      const definition = {
        renderCall: vi.fn(),
        renderResult: () => ({ render: () => ['line'] }),
      };

      renderer.onUpdate({ sessionId: 's1', toolCallId: 't1', definition, args: {}, cwd: '/', partialResult: {}, publish: vi.fn() });
      renderer.onUpdate({ sessionId: 's1', toolCallId: 't1', definition, args: {}, cwd: '/', partialResult: {}, publish: vi.fn() });

      renderer.onUpdate({ sessionId: 's2', toolCallId: 't2', definition, args: {}, cwd: '/', partialResult: {}, publish: vi.fn() });
      renderer.onUpdate({ sessionId: 's2', toolCallId: 't2', definition, args: {}, cwd: '/', partialResult: {}, publish: vi.fn() });

      expect(cancelledTimers).toHaveLength(0);
      renderer.dispose();
      expect(cancelledTimers.length).toBeGreaterThanOrEqual(2);
    });
  });
});
