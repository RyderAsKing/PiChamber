import { pathToFileURL } from 'node:url';

import { defaultPluginState } from './manifest.js';

// Agent impact is measured, not declared: the server runs a plugin's agent
// half once against a recording stand-in for the Pi extension API and reports
// what reaches the model.

/**
 * Events whose handlers can change what the model sees: the prompt, the
 * context, the provider request, tool results, or discovered resources.
 */
const PROMPT_AFFECTING_EVENTS = Object.freeze([
  'resources_discover',
  'input',
  'before_agent_start',
  'context',
  'context_with_system',
  'before_provider_request',
  'tool_result',
  'message_end',
]);

const PROMPT_AFFECTING = new Set(PROMPT_AFFECTING_EVENTS);
const MEASURE_TIMEOUT_MS = 5_000;

/** Token estimate for one tool declaration: ceil(chars / 4) of its JSON. */
export const estimateToolTokens = ({ name, description, parameters }) => (
  Math.ceil(JSON.stringify({ name, description, parameters }).length / 4)
);

// Methods that return values Pi code commonly reads during load.
const RETURNING = {
  getActiveTools: () => [],
  getAllTools: () => [],
  getCommands: () => [],
  getThinkingLevel: () => 'off',
  getSessionName: () => undefined,
  getFlag: () => undefined,
  on: () => () => {},
};

const createRecordingApi = () => {
  const tools = [];
  const hooks = new Set();
  const commands = [];
  const recorders = {
    registerTool: (tool) => {
      tools.push({
        name: String(tool?.name ?? ''),
        exposure: typeof tool?.exposure === 'string' ? tool.exposure : 'direct',
        tokens: estimateToolTokens(tool ?? {}),
      });
    },
    on: (event) => {
      if (PROMPT_AFFECTING.has(event)) hooks.add(event);
      return () => {};
    },
    registerCommand: (name) => {
      if (typeof name === 'string') commands.push(name);
    },
  };
  // Every other API member is a no-op, so plugins that set up renderers,
  // flags, or event buses still load.
  const api = new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== 'string') return undefined;
      if (Object.hasOwn(recorders, property)) return recorders[property];
      if (Object.hasOwn(RETURNING, property)) return RETURNING[property];
      if (property === 'events') return { on: () => () => {}, emit: () => {} };
      if (property === 'then') return undefined;
      return () => undefined;
    },
  });
  return {
    api,
    result: () => ({ tools, hooks: PROMPT_AFFECTING_EVENTS.filter((event) => hooks.has(event)), commands }),
  };
};

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('measurement timed out')), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
};

const shortReason = (error) => {
  const message = typeof error?.message === 'string' ? error.message : 'the agent half failed to load';
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
};

/**
 * Measure one plugin. Resolves `{ impact }` or `{ impact: null, impactError }`;
 * it never rejects.
 */
export const measurePluginImpact = async (manifest, {
  importModule = (entry) => import(pathToFileURL(entry).href),
  timeoutMs = MEASURE_TIMEOUT_MS,
} = {}) => {
  try {
    const module = await withTimeout(importModule(manifest.entry), timeoutMs);
    const factory = module?.default;
    if (typeof factory !== 'function') throw new Error('the agent half has no default export');
    const recording = createRecordingApi();
    const defaults = defaultPluginState(manifest);
    const plugin = {
      id: manifest.id,
      state: () => ({ ...defaults }),
      onStateChange: () => () => {},
    };
    await withTimeout(Promise.resolve(factory(recording.api, plugin)), timeoutMs);
    return { impact: recording.result() };
  } catch (error) {
    return { impact: null, impactError: shortReason(error) };
  }
};

/** Caches measurements per plugin id and version. */
export const createImpactCache = ({ measure = measurePluginImpact } = {}) => {
  const cache = new Map();
  return {
    get: (manifest) => {
      const key = `${manifest.id}@${manifest.version}`;
      let entry = cache.get(key);
      if (!entry) {
        entry = measure(manifest);
        cache.set(key, entry);
      }
      return entry;
    },
  };
};
