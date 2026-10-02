import React from 'react';

/**
 * How a session row lays itself out.
 *
 * - `card`: the workspace and timeline row. The title leads, the timestamp
 *   sits on the title line, and the details form a smaller, quieter second
 *   line. The working indicator overlays the right edge of the row.
 * - `tree`: the by-folder row. A compact single line (title and timestamp, no
 *   details line) whose row chrome spans the full sidebar width while its
 *   content starts under the folder label; the leading gutter that produces
 *   the indent carries the working indicator.
 */
type SessionRowVariant = 'card' | 'tree';

/**
 * Gap between the leading icon column and the label in the by-folder tree.
 * Folder headers, session rows, and session-shaped actions share it so every
 * label starts on the same line under the folder name.
 */
export const treeRowGapClassName = 'gap-2';

/**
 * Vertical rhythm of a by-folder tree row. Session rows and session-shaped
 * actions share it, and it matches the folder header's padding, so every row
 * in the tree is the same height and evenly spaced.
 */
export const treeRowSpacingClassName = 'my-0.5 rounded-lg py-1.5';

export const SessionRowVariantContext = React.createContext<SessionRowVariant>('card');
