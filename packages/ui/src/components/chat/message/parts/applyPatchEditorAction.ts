import type { EditorAPI } from '@/lib/api/types';
import { toAbsoluteFilePath } from '@/lib/path-utils';

import { extractFirstChangedLineFromDiff, getApplyPatchFilePath, getPatchText } from './toolDiffUtils';

export const openApplyPatchFileInEditor = ({
    currentDirectory,
    editor,
    file,
}: {
    currentDirectory: string;
    editor: EditorAPI;
    file: Record<string, unknown>;
}): boolean => {
    const filePath = getApplyPatchFilePath(file);
    if (!filePath || file.type === 'delete') {
        return false;
    }

    const patch = getPatchText(file.patch) ?? getPatchText(file.diff);
    const line = patch ? extractFirstChangedLineFromDiff(patch) : undefined;
    const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
    void editor.openFile(absolutePath, line);
    return true;
};
