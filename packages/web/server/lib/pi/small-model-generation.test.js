import { describe, expect, it, vi } from 'vitest';

import { createSmallModelGenerator } from './small-model-generation.js';

const createHarness = ({ waitForIdle = async () => undefined, timeoutMs = 100 } = {}) => {
  const abort = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  const session = {
    sendUserMessage: vi.fn(async () => undefined),
    waitForIdle,
    abort,
    isStreaming: false,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'fix-auth-timeout' }] }],
  };
  const selectedModel = { provider: 'provider', id: 'small' };
  const createSession = vi.fn(async () => ({ session }));
  const createServices = vi.fn(async () => ({
    modelRuntime: { getModel: () => selectedModel },
    diagnostics: [],
  }));
  const generate = createSmallModelGenerator({
    agentDir: '/agent',
    timeoutMs,
    inMemorySession: () => ({ kind: 'memory' }),
    createServices,
    createSession,
    createRuntime: async (factory, options) => ({
      ...(await factory({
        cwd: options.cwd,
        agentDir: options.agentDir,
        sessionManager: options.sessionManager,
      })),
      dispose,
    }),
  });
  return { abort, createServices, createSession, dispose, generate, selectedModel, session };
};

describe('small-model generation', () => {
  it('uses an in-memory no-tools session and returns only assistant text', async () => {
    const harness = createHarness();
    await expect(harness.generate({
      directory: '/repo',
      prompt: 'Name this task',
      model: { providerId: 'provider', modelId: 'small' },
    })).resolves.toEqual({ text: 'fix-auth-timeout' });

    expect(harness.createServices).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      resourceLoaderOptions: expect.objectContaining({
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        systemPromptOverride: expect.any(Function),
      }),
    }));
    const systemPrompt = harness.createServices.mock.calls[0][0].resourceLoaderOptions.systemPromptOverride();
    expect(systemPrompt).toContain('stateless text transformation service');
    expect(systemPrompt).toContain('Never perform the task');

    expect(harness.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: harness.selectedModel,
      noTools: 'all',
      sessionManager: { kind: 'memory' },
    }));
    expect(harness.session.sendUserMessage).toHaveBeenCalledWith('Name this task', { expandPromptTemplates: false });
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('aborts and disposes a timed-out generation', async () => {
    const harness = createHarness({ waitForIdle: () => new Promise(() => {}), timeoutMs: 5 });
    await expect(harness.generate({
      directory: '/repo',
      prompt: 'Name this task',
      model: { providerId: 'provider', modelId: 'small' },
    })).rejects.toThrow('timed out');
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });
});
