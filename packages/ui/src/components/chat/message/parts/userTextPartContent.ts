import type { AgentMentionInfo } from '../types';
import { buildAgentHref, buildSkillHref } from '@/lib/messages/inlineMessageLinks';

// Native Pi skill invocations only: `/skill:name`. Bare `/name` is never a
// skill (it may be a prompt template or extension command), so it must not
// link to skill settings. Names allow dashes and underscores; matching stays
// case-sensitive against the authoritative registry via the caller-provided set.
export const SKILL_TOKEN_PATTERN = /(^|\s)\/skill:([A-Za-z0-9][A-Za-z0-9_-]*)/g;

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

const escapeHtml = (text: string): string => {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
};

const mapNonFencedSegments = (markdown: string, mapSegment: (segment: string) => string): string => {
    return markdown
        .split(FENCED_CODE_SEGMENT_PATTERN)
        .map((segment, index) => (index % 2 === 1 ? segment : mapSegment(segment)))
        .join('');
};

// In Markdown a single "\n" is a soft break (rendered as a space). Users type plain
// text where each newline is meant literally, so convert soft breaks into hard breaks
// (two trailing spaces) outside of fenced code blocks, where newlines are already literal.
const applyHardLineBreaks = (markdown: string): string => {
    return mapNonFencedSegments(markdown, (segment) => segment.replace(/ *\n/g, '  \n'));
};

export const prepareUserMarkdownContent = ({
    textContent,
    agentMention,
    skillNames,
}: {
    textContent: string;
    agentMention?: AgentMentionInfo;
    skillNames: ReadonlySet<string>;
}): string => {
    let content = mapNonFencedSegments(textContent, escapeHtml);

    // Insert agent mention links with an internal href so markdown renders them as mentions, not external links.
    if (agentMention?.token && content.includes(agentMention.token)) {
        const mentionMarkdown = `[${agentMention.token}](${buildAgentHref(agentMention.name)})`;
        content = content.replace(agentMention.token, mentionMarkdown);
    }

    content = content.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, skillName: string) => {
        if (!skillNames.has(skillName)) return match;
        return `${prefix}[/skill:${skillName}](${buildSkillHref(skillName)})`;
    });

    // Preserve user newlines (markdown soft breaks would otherwise collapse to spaces)
    return applyHardLineBreaks(content);
};
