/**
 * Assembling what the composer actually sends.
 *
 * A single send can carry more than what the user just typed: messages queued
 * while the previous turn ran, `@file` references resolved to attachments,
 * synthetic parts from
 * conflict resolution, and an instruction naming the skills mentioned inline.
 *
 * PiChamber assembles one primary message plus additional parts, so all of that has
 * to be flattened into that shape — and the flattening has rules that are easy
 * to get wrong and impossible to see when they are spread through a 400-line
 * handler. They are stated here, as a pure function over injected resolvers,
 * so the ordering can be tested rather than trusted.
 */

import type { AttachedFile } from '@/stores/types/sessionTypes';
import { collectKnownTokenNames } from '../language/prefixTokens';


/** Resolve inline `/skill:name` tokens against the authoritative skill registry.
 * Bare `/name` is never a skill invocation: Pi SDK 0.84.1 only expands skills
 * when input starts with `/skill:<skill-name>`. Inline mentions mid-sentence
 * are not expanded by Pi (only a leading `/skill:name` is), so the collected
 * names become a synthetic hint for the model. */
export const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] => {
    if (skillNames.size === 0) return [];
    const canonicalByLower = new Map<string, string>();
    for (const name of skillNames) {
        const lower = name.toLowerCase();
        if (!canonicalByLower.has(lower)) canonicalByLower.set(lower, name);
    }
    // Scan generous `/` tokens (including `skill:name` and extension suffixes),
    // then keep only the `skill:<name>` form whose bare name exists.
    const invocationByLower = new Set<string>();
    for (const name of canonicalByLower.keys()) invocationByLower.add(`skill:${name}`);
    const matched = collectKnownTokenNames(text, '/', invocationByLower, 'case-insensitive');
    const seen = new Set<string>();
    const resolved: string[] = [];
    for (const invocation of matched) {
        const bare = invocation.slice('skill:'.length);
        const canonical = canonicalByLower.get(bare.toLowerCase()) ?? bare;
        const key = canonical.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push(canonical);
    }
    return resolved;
};

export const buildSkillMentionInstruction = (skillNames: string[]): string | null => {
    if (skillNames.length === 0) return null;
    const formatted = skillNames.map((name) => `/skill:${name}`).join(', ');
    return `The user explicitly mentioned these skills in their message: ${formatted}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`;
};

export interface OutgoingPart {
    text: string;
    attachments?: AttachedFile[];
    /** Synthetic parts are context for the model, not shown as user content. */
    synthetic?: boolean;
}

export interface OutgoingMessage {
    primaryText: string;
    primaryAttachments: AttachedFile[];
    additionalParts: OutgoingPart[];
    /** The agent the first `@agent` mention routed to, if any. */
    agentMentionName?: string;
    /** True when there is nothing worth sending. */
    isEmpty: boolean;
}

export interface QueuedInput {
    content: string;
    attachments?: AttachedFile[];
}

export interface OutgoingMessageInput {
    /** Messages queued while a turn was running, oldest first. */
    queued: readonly QueuedInput[];
    /** The composer's own text, or null when this send skips it. */
    composerText: string | null;
    composerAttachments: readonly AttachedFile[];
    /** Synthetic context produced elsewhere (conflict resolution, and such). */
    syntheticTexts: readonly string[];
}

/**
 * The parts of assembly that depend on stores or async config, injected so the
 * assembly itself stays pure.
 */
export interface OutgoingMessageDeps {
    /** Strip a leading `@agent` mention and report which agent it named. */
    parseAgentMention: (text: string) => { text: string; agentName?: string };
    /** Resolve `@path` references into server-side attachments. */
    extractFileMentions: (text: string) => { text: string; attachments: AttachedFile[] };
    /** Normalize attachments for transport (server paths become file URLs). */
    sanitizeAttachments: (files: readonly AttachedFile[] | undefined) => AttachedFile[];
    /** Skills named inline with `/name`. */
    collectSkillNames: (text: string) => string[];
    /** Instruction telling the model which skills the user named. */
    buildSkillInstruction: (names: string[]) => string | null;
}

export function buildOutgoingMessage(
    input: OutgoingMessageInput,
    deps: OutgoingMessageDeps,
): OutgoingMessage {
    let primaryText = '';
    let primaryAttachments: AttachedFile[] = [];
    let agentMentionName: string | undefined;
    const additionalParts: OutgoingPart[] = [];

    const skillNames: string[] = [];
    const noteSkills = (text: string) => {
        for (const name of deps.collectSkillNames(text)) {
            if (!skillNames.includes(name)) skillNames.push(name);
        }
    };

    /** The first agent mention encountered wins; later ones are ignored. */
    const noteAgent = (name?: string) => {
        if (!agentMentionName && name) agentMentionName = name;
    };

    /** Run a body through mention parsing, collecting its side effects. */
    const resolve = (raw: string) => {
        const agent = deps.parseAgentMention(raw);
        noteAgent(agent.agentName);
        const mentions = deps.extractFileMentions(agent.text);
        noteSkills(mentions.text);
        return mentions;
    };

    // Queued messages come first, in the order they were queued: the oldest
    // becomes the primary message so the turn reads chronologically.
    input.queued.forEach((queued, index) => {
        const resolved = resolve(queued.content);
        const attachments = [
            ...deps.sanitizeAttachments(queued.attachments),
            ...resolved.attachments,
        ];

        if (index === 0) {
            primaryText = resolved.text;
            primaryAttachments = attachments;
            return;
        }
        additionalParts.push({ text: resolved.text, attachments });
    });

    // The composer's own text follows, becoming primary only when nothing was
    // queued ahead of it.
    if (input.composerText !== null) {
        const resolved = resolve(input.composerText.replace(/^\n+|\n+$/g, ''));
        const attachments = [
            ...deps.sanitizeAttachments(input.composerAttachments),
            ...resolved.attachments,
        ];

        if (input.queued.length === 0) {
            primaryText = resolved.text;
            primaryAttachments = attachments;
        } else {
            additionalParts.push({ text: resolved.text, attachments });
        }
    }

    // Everything below is context for the model, never user-visible content.
    for (const text of input.syntheticTexts) {
        additionalParts.push({ text, synthetic: true });
    }

    const skillInstruction = deps.buildSkillInstruction(skillNames);
    if (skillInstruction) {
        additionalParts.push({ text: skillInstruction, synthetic: true });
    }

    return {
        primaryText,
        primaryAttachments,
        additionalParts,
        agentMentionName,
        isEmpty: !primaryText && primaryAttachments.length === 0 && additionalParts.length === 0,
    };
}
