import { getLanguageFromExtension } from './fileTypes';

export * from './fileTypes';

export interface ToolMetadata {
  displayName: string;
  icon?: string;
  outputLanguage?: string;
  inputFields?: {
    key: string;
    label: string;
    type: 'command' | 'file' | 'pattern' | 'text' | 'code';
    language?: string;
  }[];
  category: 'file' | 'search' | 'code' | 'system' | 'ai' | 'web';
}

const TOOL_METADATA: Record<string, ToolMetadata> = {
  read: {
    displayName: 'Read file',
    category: 'file',
    outputLanguage: 'auto',
    inputFields: [
      { key: 'filePath', label: 'File path', type: 'file' },
      { key: 'offset', label: 'Start line', type: 'text' },
      { key: 'limit', label: 'Lines to read', type: 'text' },
    ],
  },
  write: {
    displayName: 'Write file',
    category: 'file',
    outputLanguage: 'auto',
    inputFields: [
      { key: 'filePath', label: 'File path', type: 'file' },
      { key: 'content', label: 'Content', type: 'code' },
    ],
  },
  edit: {
    displayName: 'Edit file',
    category: 'file',
    outputLanguage: 'diff',
    inputFields: [
      { key: 'filePath', label: 'File path', type: 'file' },
      { key: 'oldString', label: 'Find', type: 'code' },
      { key: 'newString', label: 'Replace', type: 'code' },
      { key: 'replaceAll', label: 'Replace all', type: 'text' },
    ],
  },
  multiedit: {
    displayName: 'Multi-Edit',
    category: 'file',
    outputLanguage: 'diff',
    inputFields: [
      { key: 'filePath', label: 'File path', type: 'file' },
      { key: 'edits', label: 'Edits', type: 'code', language: 'json' },
    ],
  },
  apply_patch: {
    displayName: 'Apply patch',
    category: 'file',
    outputLanguage: 'diff',
    inputFields: [
      { key: 'patchText', label: 'Patch', type: 'code', language: 'diff' },
    ],
  },

  bash: {
    displayName: 'Shell command',
    category: 'system',
    outputLanguage: 'text',
    inputFields: [
      { key: 'command', label: 'Command', type: 'command', language: 'bash' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'timeout', label: 'Timeout (ms)', type: 'text' },
    ],
  },

  grep: {
    displayName: 'Search files',
    category: 'search',
    outputLanguage: 'text',
    inputFields: [
      { key: 'pattern', label: 'Pattern', type: 'pattern' },
      { key: 'path', label: 'Directory', type: 'file' },
      { key: 'include', label: 'Include pattern', type: 'pattern' },
    ],
  },
  glob: {
    displayName: 'Find files',
    category: 'search',
    outputLanguage: 'text',
    inputFields: [
      { key: 'pattern', label: 'Pattern', type: 'pattern' },
      { key: 'path', label: 'Directory', type: 'file' },
    ],
  },
  list: {
    displayName: 'List directory',
    category: 'file',
    outputLanguage: 'text',
    inputFields: [
      { key: 'path', label: 'Directory', type: 'file' },
      { key: 'ignore', label: 'Ignore patterns', type: 'pattern' },
    ],
  },

  task: {
    displayName: 'Agent task',
    category: 'ai',
    outputLanguage: 'markdown',
    inputFields: [
      { key: 'description', label: 'Task', type: 'text' },
      { key: 'prompt', label: 'Instructions', type: 'text' },
      { key: 'subagent_type', label: 'Agent type', type: 'text' },
    ],
  },

  webfetch: {
    displayName: 'Fetch URL',
    category: 'web',
    outputLanguage: 'auto',
    inputFields: [
      { key: 'url', label: 'URL', type: 'text' },
      { key: 'format', label: 'Format', type: 'text' },
      { key: 'timeout', label: 'Timeout', type: 'text' },
    ],
  },

  websearch: {
    displayName: 'Web search',
    category: 'web',
    outputLanguage: 'markdown',
    inputFields: [
      { key: 'query', label: 'Search query', type: 'text' },
      { key: 'numResults', label: 'Results count', type: 'text' },
      { key: 'type', label: 'Search type', type: 'text' },
    ],
  },
  codesearch: {
    displayName: 'Code search',
    category: 'web',
    outputLanguage: 'markdown',
    inputFields: [
      { key: 'query', label: 'Search query', type: 'text' },
      { key: 'tokensNum', label: 'Tokens', type: 'text' },
    ],
  },

  todowrite: {
    displayName: 'Update todo list',
    category: 'system',
    outputLanguage: 'json',
    inputFields: [
      { key: 'todos', label: 'Todo items', type: 'code', language: 'json' },
    ],
  },
  todoread: {
    displayName: 'Read todo list',
    category: 'system',
    outputLanguage: 'json',
    inputFields: [],
  },
  skill: {
    displayName: 'Skill',
    category: 'ai',
    outputLanguage: 'markdown',
    inputFields: [
      { key: 'name', label: 'Skill name', type: 'text' },
    ],
  },
  question: {
    displayName: 'Question',
    category: 'ai',
    outputLanguage: 'text',
    inputFields: [
      { key: 'questions', label: 'Questions', type: 'code', language: 'json' },
    ],
  },

  lsp: {
    displayName: 'LSP',
    category: 'code',
    outputLanguage: 'json',
    inputFields: [
      { key: 'operation', label: 'Operation', type: 'text' },
      { key: 'filePath', label: 'File path', type: 'file' },
      { key: 'line', label: 'Line', type: 'text' },
      { key: 'character', label: 'Character', type: 'text' },
      { key: 'query', label: 'Query', type: 'text' },
    ],
  },

  pichamber: {
    displayName: 'PiChamber',
    category: 'system',
    outputLanguage: 'json',
    inputFields: [],
  },

  plan_enter: {
    displayName: 'Plan mode',
    category: 'ai',
    outputLanguage: 'text',
    inputFields: [],
  },

  plan_exit: {
    displayName: 'Build mode',
    category: 'ai',
    outputLanguage: 'text',
    inputFields: [],
  },

  StructuredOutput: {
    displayName: 'Structured output',
    category: 'ai',
    outputLanguage: 'json',
    inputFields: [],
  },

  structuredoutput: {
    displayName: 'Structured output',
    category: 'ai',
    outputLanguage: 'json',
    inputFields: [],
  },
};

function formatUnknownToolDisplayName(toolName: string): string {
  return toolName
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase());
}

export function getToolMetadata(toolName: string): ToolMetadata {
  return (
    TOOL_METADATA[toolName] || {
      displayName: formatUnknownToolDisplayName(toolName),
      category: 'system',
      outputLanguage: 'text',
      inputFields: [],
    }
  );
}

export function detectToolOutputLanguage(
  toolName: string,
  output: string,
  input?: Record<string, unknown>,
): string {
  const metadata = getToolMetadata(toolName);

  if (metadata.outputLanguage === 'auto') {
    if (input?.filePath || input?.file_path || input?.sourcePath) {
      const filePath = (input.filePath || input.file_path || input.sourcePath) as string;
      const language = getLanguageFromExtension(filePath);
      if (language) return language;
    }

    if (toolName === 'webfetch') {
      if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
        try {
          JSON.parse(output);
          return 'json';
        } catch {
          /* ignored */
        }
      }
      if (output.trim().startsWith('<')) {
        return 'html';
      }
      if (output.includes('```')) {
        return 'markdown';
      }
    }

    return 'text';
  }

  return metadata.outputLanguage || 'text';
}

export function formatToolInput(input: Record<string, unknown>, toolName: string): string {
  if (!input) return '';

  const getString = (key: string): string | null => {
    const val = input[key];
    return typeof val === 'string' ? val : typeof val === 'number' ? String(val) : null;
  };

  if (toolName === 'bash') {
    const cmd = getString('command');
    if (cmd) return cmd;
  }

  if (toolName === 'lsp') {
    const operation = getString('operation') || 'lsp';
    const filePath = getString('filePath') || getString('file_path') || getString('path');
    const line = getString('line');
    const character = getString('character');
    const query = getString('query');
    const position = line && character ? ` (Line: ${line}; Character: ${character})` : '';

    if (operation === 'workspaceSymbol') {
      return query ? `Operation: ${operation} (Query: "${query}")` : `Operation: ${operation}`;
    }

    const summary = `Operation: ${operation}${position}`;
    if (filePath) {
      return `${summary}\n${filePath}`;
    }

    return summary;
  }

  if (toolName === 'task') {
    const prompt = getString('prompt');
    if (prompt) return prompt;
    const desc = getString('description');
    if (desc) return desc;
  }

  if (toolName === 'apply_patch' && typeof input === 'object') {
    const patchText = getString('patchText') || getString('patch_text') || getString('patch');
    if (patchText) {
      return patchText;
    }
  }

  if ((toolName === 'edit' || toolName === 'multiedit') && typeof input === 'object') {
    const filePath = getString('filePath') || getString('file_path') || getString('path');
    if (filePath) {
      return `File path: ${filePath}`;
    }
  }

  if (toolName === 'write' && typeof input === 'object') {
    const content = getString('content');
    if (content) {
      return content;
    }
  }

  if (typeof input === 'object') {
    const entries = Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => {
        const formattedKey = key
          .replace(/([A-Z])/g, ' $1')
          .replace(/_/g, ' ')
          .toLowerCase()
          .replace(/^./, (str) => str.toUpperCase());

        let formattedValue = value;
        if (typeof value === 'object') {
          formattedValue = JSON.stringify(value, null, 2);
        } else if (typeof value === 'boolean') {
          formattedValue = value ? 'Yes' : 'No';
        }

        return `${formattedKey}: ${formattedValue}`;
      });

    return entries.join('\n');
  }

  return String(input);
}
