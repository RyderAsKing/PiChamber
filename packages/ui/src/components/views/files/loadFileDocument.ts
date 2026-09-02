import {
  isBinaryFile,
  isImageFile,
  isPdfFile,
  isSvgFile,
  looksLikeBinaryText,
} from '@/lib/toolHelpers';
import {
  MAX_VIEW_CHARS,
  detectFileLineEnding,
  normalizeEditorLineEndings,
  type FileLineEnding,
} from './filesViewModel';

export type FileDocumentLoadResult =
  | { kind: 'desktop-image' }
  | { kind: 'asset-image' }
  | { kind: 'pdf' }
  | { kind: 'binary'; detectedFromContent: boolean }
  | {
      kind: 'text';
      content: string;
      draft: string;
      lineEnding: FileLineEnding;
    };

type FileDocumentLoader = (path: string) => Promise<string>;

/**
 * Classifies and loads one file without owning selection or React state.
 * Known binary formats never cross the text transport, and text is normalized
 * once here so every Files chrome gets the same draft and line-ending policy.
 */
export async function loadFileDocument(
  path: string,
  isDesktop: boolean,
  readText: FileDocumentLoader,
): Promise<FileDocumentLoadResult> {
  const image = isImageFile(path);
  if (image && !isSvgFile(path)) {
    return { kind: isDesktop ? 'desktop-image' : 'asset-image' };
  }
  if (isPdfFile(path)) return { kind: 'pdf' };
  if (isBinaryFile(path)) return { kind: 'binary', detectedFromContent: false };

  const raw = await readText(path);
  if (looksLikeBinaryText(raw)) {
    return { kind: 'binary', detectedFromContent: true };
  }

  const content = normalizeEditorLineEndings(raw);
  return {
    kind: 'text',
    content,
    draft: content.length > MAX_VIEW_CHARS
      ? `${content.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`
      : content,
    lineEnding: detectFileLineEnding(raw),
  };
}
