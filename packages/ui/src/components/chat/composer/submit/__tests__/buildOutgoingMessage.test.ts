import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import {
    buildOutgoingMessage,
    type OutgoingMessageDeps,
    type OutgoingMessageInput,
} from '../buildOutgoingMessage';

const attachment = (id: string) => ({ id, filename: `${id}.txt` } as unknown as AttachedFile);

/**
 * Resolvers with just enough behavior to observe ordering: `@agent:name`
 * names an agent, `@file:x` resolves to an attachment, `/skill` is a skill.
 */
const deps = (overrides: Partial<OutgoingMessageDeps> = {}): OutgoingMessageDeps => ({
    parseAgentMention: (text) => {
        const match = /@agent:(\w+)\s*/.exec(text);
        return match
            ? { text: text.replace(match[0], ''), agentName: match[1] }
            : { text };
    },
    extractFileMentions: (text) => {
        const attachments = [...text.matchAll(/@file:(\w+)/g)].map((m) => attachment(m[1]));
        return { text, attachments };
    },
    sanitizeAttachments: (files) => [...(files ?? [])],
    collectSkillNames: (text) => [...text.matchAll(/\/(\w+)/g)].map((m) => m[1]),
    buildSkillInstruction: (names) => (names.length ? `use: ${names.join(',')}` : null),
    ...overrides,
});

const input = (overrides: Partial<OutgoingMessageInput> = {}): OutgoingMessageInput => ({
    queued: [],
    composerText: null,
    composerAttachments: [],
    syntheticTexts: [],
    ...overrides,
});

describe('the composer text alone', () => {
    test('becomes the primary message', () => {
        const result = buildOutgoingMessage(input({ composerText: 'hello' }), deps());
        expect(result.primaryText).toBe('hello');
        expect(result.additionalParts).toEqual([]);
        expect(result.isEmpty).toBe(false);
    });

    test('surrounding blank lines are trimmed', () => {
        expect(buildOutgoingMessage(input({ composerText: '\n\nhello\n\n' }), deps()).primaryText)
            .toBe('hello');
    });

    test('interior blank lines are preserved', () => {
        expect(buildOutgoingMessage(input({ composerText: 'a\n\nb' }), deps()).primaryText)
            .toBe('a\n\nb');
    });

    test('its attachments and resolved file mentions travel with it', () => {
        const result = buildOutgoingMessage(
            input({ composerText: 'see @file:doc', composerAttachments: [attachment('pic')] }),
            deps(),
        );
        expect(result.primaryAttachments.map((a) => a.id)).toEqual(['pic', 'doc']);
    });

    test('nothing at all is empty', () => {
        expect(buildOutgoingMessage(input(), deps()).isEmpty).toBe(true);
    });
});

describe('queued messages', () => {
    test('the oldest becomes primary and the rest follow in order', () => {
        const result = buildOutgoingMessage(input({
            queued: [{ content: 'first' }, { content: 'second' }, { content: 'third' }],
        }), deps());
        expect(result.primaryText).toBe('first');
        expect(result.additionalParts.map((p) => p.text)).toEqual(['second', 'third']);
    });

    test('the composer text lands after everything queued', () => {
        const result = buildOutgoingMessage(input({
            queued: [{ content: 'queued' }],
            composerText: 'typed now',
        }), deps());
        expect(result.primaryText).toBe('queued');
        expect(result.additionalParts.map((p) => p.text)).toEqual(['typed now']);
    });

    test('each queued message keeps its own attachments', () => {
        const result = buildOutgoingMessage(input({
            queued: [
                { content: 'a', attachments: [attachment('one')] },
                { content: 'b', attachments: [attachment('two')] },
            ],
        }), deps());
        expect(result.primaryAttachments.map((a) => a.id)).toEqual(['one']);
        expect(result.additionalParts[0].attachments?.map((a) => a.id)).toEqual(['two']);
    });
});

describe('agent mentions', () => {
    test('an agent named in the composer routes the send', () => {
        expect(buildOutgoingMessage(input({ composerText: '@agent:build do it' }), deps())
            .agentMentionName).toBe('build');
    });

    test('the first mention wins across queued messages', () => {
        const result = buildOutgoingMessage(input({
            queued: [{ content: '@agent:plan a' }, { content: '@agent:build b' }],
        }), deps());
        expect(result.agentMentionName).toBe('plan');
    });

    test('a queued mention outranks one typed later', () => {
        const result = buildOutgoingMessage(input({
            queued: [{ content: '@agent:plan a' }],
            composerText: '@agent:build b',
        }), deps());
        expect(result.agentMentionName).toBe('plan');
    });

    test('no mention leaves the routing unset', () => {
        expect(buildOutgoingMessage(input({ composerText: 'plain' }), deps()).agentMentionName)
            .toBe(undefined);
    });
});

describe('synthetic context', () => {
    test('synthetic texts are sent as model-only context', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'x',
            syntheticTexts: ['conflict note'],
        }), deps());
        expect(result.additionalParts).toEqual([{ text: 'conflict note', synthetic: true }]);
    });

    test('skills named inline are collected into a trailing instruction', () => {
        const result = buildOutgoingMessage(input({ composerText: 'use /deploy now' }), deps());
        expect(result.additionalParts.at(-1)).toEqual({ text: 'use: deploy', synthetic: true });
    });

    test('skills are collected across every authored body, without duplicates', () => {
        const result = buildOutgoingMessage(input({
            queued: [{ content: '/deploy a' }],
            composerText: '/deploy and /audit',
        }), deps());
        expect(result.additionalParts.at(-1)?.text).toBe('use: deploy,audit');
    });

    test('no skills means no instruction', () => {
        const result = buildOutgoingMessage(input({ composerText: 'plain text' }), deps());
        expect(result.additionalParts).toEqual([]);
    });

    test('attachments alone are worth sending', () => {
        const result = buildOutgoingMessage(
            input({ composerText: '', composerAttachments: [attachment('pic')] }),
            deps(),
        );
        expect(result.isEmpty).toBe(false);
    });
});
