// KaTeX's stylesheet loads through this shared font module so every surface
// (web, mobile, mini-chat, Electron) gets it eagerly with the main bundle —
// the same reason it previously lived in index.css, where late injection on
// the first markdown render caused a style-recalc flash. It must be a JS-side
// import: Tailwind v4 inlines CSS `@import`s without rebasing their relative
// url() references, so Vite warns "didn't resolve at build time" and ships no
// KaTeX font files — the built CSS then 404s the fonts at runtime.
import 'katex/dist/katex.min.css';

// Default fonts use system stacks. Optional user-selected fonts are loaded on demand.
