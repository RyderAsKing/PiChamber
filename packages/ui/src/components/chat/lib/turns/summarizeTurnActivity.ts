import type { ToolPart } from '@/lib/chat/types';
import { normalizeToolName } from '../../message/parts/toolRenderUtils';
import { getPrimaryToolPath } from '../../message/parts/toolDiffUtils';
import type { TurnActivityRecord } from './types';

export interface TurnActivitySummary {
    /** Distinct files read; calls without a path count once each. */
    filesRead: number;
    /** Distinct files edited or written; calls without a path count once each. */
    filesEdited: number;
    commands: number;
    searches: number;
    fetches: number;
    subagents: number;
    /** Tools outside the named kinds (extension, MCP, plan, question, todo). */
    otherTools: number;
    failed: number;
}

const READ_TOOLS = new Set(['read', 'view', 'file_read', 'cat']);
const EDIT_TOOLS = new Set([
    'edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_based_edit_tool',
    'write', 'create', 'file_write',
]);
const COMMAND_TOOLS = new Set(['bash', 'shell', 'cmd', 'terminal']);
const SEARCH_TOOLS = new Set([
    'grep', 'find', 'glob', 'ls', 'list', 'list_files', 'search', 'ripgrep', 'codesearch',
    'websearch', 'web-search', 'search_web',
]);
const FETCH_TOOLS = new Set(['fetch', 'webfetch', 'curl', 'wget']);
const SUBAGENT_TOOLS = new Set(['task', 'subagent']);
const FAILED_STATUSES = new Set(['error', 'failed', 'timeout']);

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
);

const readPath = (input: Record<string, unknown> | undefined): string | null => {
    for (const key of ['path', 'filePath', 'file_path']) {
        const value = input?.[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
};

/**
 * Counts what a turn did, from its tool calls, for the one-line summary beside
 * `Worked for`. Reasoning and progress text are not counted. Files are counted
 * by path so re-reading or re-editing one file reads as one.
 */
export function summarizeTurnActivity(activityParts: readonly TurnActivityRecord[]): TurnActivitySummary {
    const read = new Set<string>();
    const edited = new Set<string>();
    let unnamedReads = 0;
    let unnamedEdits = 0;
    const summary: TurnActivitySummary = {
        filesRead: 0,
        filesEdited: 0,
        commands: 0,
        searches: 0,
        fetches: 0,
        subagents: 0,
        otherTools: 0,
        failed: 0,
    };

    for (const activity of activityParts) {
        if (activity.kind !== 'tool' || activity.part.type !== 'tool') continue;
        const part = activity.part as ToolPart;
        const name = normalizeToolName(part.tool);
        const input = asRecord(part.state?.input);
        const status = typeof part.state?.status === 'string' ? part.state.status : '';
        if (FAILED_STATUSES.has(status)) summary.failed += 1;

        if (READ_TOOLS.has(name)) {
            const path = readPath(input);
            if (path) read.add(path);
            else unnamedReads += 1;
        } else if (EDIT_TOOLS.has(name)) {
            const path = getPrimaryToolPath(name, input, part.state?.metadata) ?? readPath(input);
            if (path) edited.add(path);
            else unnamedEdits += 1;
        } else if (COMMAND_TOOLS.has(name)) {
            summary.commands += 1;
        } else if (SEARCH_TOOLS.has(name)) {
            summary.searches += 1;
        } else if (FETCH_TOOLS.has(name)) {
            summary.fetches += 1;
        } else if (SUBAGENT_TOOLS.has(name)) {
            summary.subagents += 1;
        } else {
            summary.otherTools += 1;
        }
    }

    summary.filesRead = read.size + unnamedReads;
    summary.filesEdited = edited.size + unnamedEdits;
    return summary;
}

const count = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** Clauses in reading order; failures last. Empty when the turn used no tools. */
export function formatTurnActivityClauses(summary: TurnActivitySummary): string[] {
    const clauses: string[] = [];
    if (summary.filesRead > 0) clauses.push(`Read ${count(summary.filesRead, 'file', 'files')}`);
    if (summary.searches > 0) clauses.push(`${count(summary.searches, 'search', 'searches')}`);
    if (summary.fetches > 0) clauses.push(`Fetched ${count(summary.fetches, 'page', 'pages')}`);
    if (summary.filesEdited > 0) clauses.push(`Edited ${count(summary.filesEdited, 'file', 'files')}`);
    if (summary.commands > 0) clauses.push(`Ran ${count(summary.commands, 'command', 'commands')}`);
    if (summary.subagents > 0) clauses.push(count(summary.subagents, 'sub-agent', 'sub-agents'));
    if (summary.otherTools > 0) {
        const named = clauses.length > 0;
        clauses.push(`${count(summary.otherTools, named ? 'other tool' : 'tool', named ? 'other tools' : 'tools')}`);
    }
    return clauses;
}
