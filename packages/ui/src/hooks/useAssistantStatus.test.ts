import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/chat/types';
import type { PiReducerMessagePart } from '@/lib/pi/event-reducer';

import {
    getActiveAssistantContext,
    getAssistantActivityStatus,
    getPiAssistantActivityStatus,
} from './useAssistantStatus';

const userMessage = (id: string, providerID: string, modelID: string): Message => ({
    id,
    role: 'user',
    sessionID: 'ses_1',
    time: { created: 1 },
    model: { providerID, modelID },
} as Message);

const assistantMessage = (id: string, parentID: string): Message => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    parentID,
    time: { created: 2 },
} as Message);

describe('getAssistantActivityStatus', () => {
    test('maps namespaced Pi tools to stable activity categories', () => {
        const runningTool = (tool: string): Part => ({
            id: `tool-${tool}`,
            type: 'tool',
            tool,
            state: { status: 'running' },
        } as Part);

        expect(getAssistantActivityStatus([runningTool('functions.read')], 'turn-1').statusText).toBe('reading files');
        expect(getAssistantActivityStatus([runningTool('bash')], 'turn-1').statusText).toBe('executing commands');
        expect(getAssistantActivityStatus([runningTool('apply_patch')], 'turn-1').statusText).toBe('editing files');
    });

    test('reports thinking and final-response composition from live parts', () => {
        const reasoning = { id: 'reasoning-1', type: 'reasoning', text: 'Checking' } as Part;
        const text = { id: 'text-1', type: 'text', text: 'Answer' } as Part;

        expect(getAssistantActivityStatus([reasoning], 'turn-1').statusText).toBe('thinking');
        expect(getAssistantActivityStatus([text], 'turn-1').statusText).toBe('writing response');
    });

    test('prefers the authoritative running Pi tool over settled thinking', () => {
        const parts = new Map<string, PiReducerMessagePart>([
            ['thinking', {
                id: 'thinking', index: 0, type: 'thinking', text: 'Planning', streaming: false,
            }],
            ['tool', {
                id: 'tool', index: 1, type: 'tool', text: '', streaming: true,
                tool: { toolCallId: 'call-1', name: 'functions.read', state: 'running' },
            }],
        ]);

        expect(getPiAssistantActivityStatus(parts, ['thinking', 'tool'], 'turn-1')).toEqual({
            activePartType: 'tool',
            activeToolName: 'read',
            statusText: 'reading files',
            isGenericStatus: false,
        });

        parts.set('tool', {
            ...parts.get('tool')!,
            streaming: false,
            tool: { ...parts.get('tool')!.tool!, state: 'completed' },
        });
        parts.set('text', {
            id: 'text', index: 2, type: 'text', text: 'Final answer', streaming: true,
        });

        expect(getPiAssistantActivityStatus(parts, ['thinking', 'tool', 'text'], 'turn-1').statusText)
            .toBe('writing response');
    });
});

describe('getActiveAssistantContext', () => {
    test('uses the active assistant parent model instead of the latest user selection', () => {
        const activeParent = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const assistant = assistantMessage('assistant_1', activeParent.id);
        const laterSelection = userMessage('user_2', 'openai', 'gpt-5.6-sol');

        expect(getActiveAssistantContext([activeParent, assistant, laterSelection])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('switches models only when a newer assistant links to the newer user message', () => {
        const firstUser = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const firstAssistant = assistantMessage('assistant_1', firstUser.id);
        const secondUser = userMessage('user_2', 'openai', 'gpt-5.6-sol');
        const secondAssistant = assistantMessage('assistant_2', secondUser.id);

        expect(getActiveAssistantContext([firstUser, firstAssistant, secondUser, secondAssistant])).toEqual({
            assistantId: secondAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-sol',
            },
        });
    });

    test('does not guess a model when the parent message is unavailable', () => {
        const assistant = assistantMessage('assistant_1', 'missing_user');

        expect(getActiveAssistantContext([assistant])).toEqual({
            assistantId: assistant.id,
            model: null,
        });
    });
});
