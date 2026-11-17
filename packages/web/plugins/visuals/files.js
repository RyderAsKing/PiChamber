// Visuals: reading pages and images from the session's project folder.
// Every path is resolved through links and must stay inside the project.

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export const MAX_PAGE_CHARS = 512_000;
/** One image file, before it is encoded. */
export const MAX_IMAGE_BYTES = 750_000;

const PAGE_EXTENSIONS = new Set(['.html', '.htm']);
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
]);

const isInside = (root, target) => {
  const fromRoot = relative(root, target);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
};

/** `what` names the thing in error text: "page" or "file". */
const resolveProjectFile = async (cwd, path, what) => {
  const name = what === 'file' ? 'file' : `${what} file`;
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error(`No project folder to read the ${what} from.`);
  if (typeof path !== 'string' || path.trim().length === 0) throw new Error('path is empty.');
  let root;
  let file;
  try {
    root = await realpath(cwd);
    file = await realpath(resolve(root, path.trim()));
  } catch {
    throw new Error(`The ${name} was not found.`);
  }
  if (!isInside(root, file)) throw new Error(`The ${name} must be inside the project folder.`);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`The ${what} path is not a file.`);
  return { file, size: info.size, extension: extname(file).toLowerCase() };
};

const readPageFile = async ({ file, size }) => {
  // A UTF-8 character is at most 4 bytes; skip reading what cannot fit.
  if (size > MAX_PAGE_CHARS * 4) throw new Error(`The page is longer than ${MAX_PAGE_CHARS} characters.`);
  return readFile(file, 'utf8');
};

const readImageFile = async ({ file, size, extension }) => {
  if (size === 0) throw new Error('The image file is empty.');
  if (size > MAX_IMAGE_BYTES) throw new Error(`The image is larger than ${Math.round(MAX_IMAGE_BYTES / 1000)} KB.`);
  const bytes = await readFile(file);
  return `data:${IMAGE_TYPES.get(extension)};base64,${bytes.toString('base64')}`;
};

/** The text of an `.html` or `.htm` file in the project. */
export const readPage = async (cwd, path) => {
  const found = await resolveProjectFile(cwd, path, 'page');
  if (!PAGE_EXTENSIONS.has(found.extension)) throw new Error('The page file must be .html or .htm.');
  return readPageFile(found);
};

/**
 * A page or an image in the project, by its extension: `{ html }` for a
 * page, `{ image }` (a `data:` URL) for a picture.
 */
export const readPageOrImage = async (cwd, path) => {
  const found = await resolveProjectFile(cwd, path, 'file');
  if (PAGE_EXTENSIONS.has(found.extension)) return { html: await readPageFile(found) };
  if (IMAGE_TYPES.has(found.extension)) return { image: await readImageFile(found) };
  throw new Error('The file must be .html, .htm, .png, .jpg, .jpeg, .webp, .gif or .svg.');
};
