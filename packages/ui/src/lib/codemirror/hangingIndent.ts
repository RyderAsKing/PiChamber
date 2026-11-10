import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** How far a wrapped row sits past its line's own indentation, in characters. */
const HANG = 2;
/** Deeply indented lines stop hanging further, so a narrow editor keeps room for text. */
const MAX_INDENT = 24;
/** CodeMirror's own left padding on `.cm-line`. */
const LINE_PADDING_PX = 6;

/** Columns of leading whitespace, counting a tab as `tabSize` columns. */
export const leadingIndentColumns = (text: string, tabSize: number): number => {
  let columns = 0;
  for (const char of text) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += tabSize - (columns % tabSize);
    else break;
  }
  return columns;
};

const decorationFor = new Map<number, Decoration>();
const lineDecoration = (indent: number): Decoration => {
  let decoration = decorationFor.get(indent);
  if (!decoration) {
    const hang = indent + HANG;
    decoration = Decoration.line({
      attributes: { style: `padding-left: calc(${LINE_PADDING_PX}px + ${hang}ch); text-indent: -${hang}ch` },
    });
    decorationFor.set(indent, decoration);
  }
  return decoration;
};

const build = (view: EditorView): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, tabSize } = view.state;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const indent = Math.min(leadingIndentColumns(line.text, tabSize), MAX_INDENT);
      builder.add(line.from, line.from, lineDecoration(indent));
      pos = line.to + 1;
    }
  }
  return builder.finish();
};

/**
 * With line wrapping on, each wrapped row starts a little past where its line's
 * code starts, so a continuation never lines up with the next source line.
 * The line's first row keeps its place.
 */
export const wrappedLineHangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
