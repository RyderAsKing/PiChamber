import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';
import { themeStoragePlugin } from '../../vite-theme-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const pwaDevEnabled = process.env.PICHAMBER_DISABLE_PWA_DEV !== '1';
const reactScanToggle = (process.env.VITE_ENABLE_REACT_SCAN ?? '').toLowerCase();
const enableReactScan = reactScanToggle === '1' || reactScanToggle === 'true' || reactScanToggle === 'on' || reactScanToggle === 'yes';
const reactCompilerToggle = (process.env.VITE_REACT_COMPILER ?? '').toLowerCase();
// The React Compiler babel pass runs a full optimizing compiler over every
// module and costs ~25s of the ~52s production build (measured), plus a
// per-transform slowdown in dev. It is opt-in: set VITE_REACT_COMPILER=1 for
// release builds that want compiler memoization in the shipped bundle.
const enableReactCompiler = reactCompilerToggle === '1' || reactCompilerToggle === 'true' || reactCompilerToggle === 'on' || reactCompilerToggle === 'yes';
const themeDirectory = path.resolve(__dirname, '../ui/src/lib/theme/themes');

// The development proxy points Host at the API. Forward the address the
// browser used, so the server recognizes requests from its own UI as
// same-site (the cross-site request check reads X-Forwarded-Host).
const forwardBrowserHost: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('proxyReq', (proxyReq, req) => {
    if (req.headers.host) proxyReq.setHeader('x-forwarded-host', req.headers.host);
  });
};

// Rollup's manualChunks module-graph accessors (the subset used here).
type ChunkGraph = {
  getModuleIds: () => IterableIterator<string>;
  getModuleInfo: (id: string) => { importedIds: readonly string[] } | null;
};

const normalizeModuleId = (id: string): string => id.replace(/\\/g, '/');
const WORKSPACE_UI_ENTRY = '/packages/ui/src/main.tsx';
const HTML_ENTRY_SHELLS = ['index.html', 'mobile.html', 'mini-chat.html'].map((name) => normalizeModuleId(path.resolve(__dirname, name)));

// Packages the workspace UI imports statically at boot (reachable from
// `ui/src/main.tsx` without crossing a dynamic import). Built once per build;
// reset by `bootVendorGraphPlugin`. Modules the HTML entry shells reach are
// excluded so the small entry scripts (web, hosted mobile, mini chat) keep
// their own chunks instead of statically depending on the whole boot chunk.
let uiBootModules: Set<string> | null = null;

const collectStaticGraph = (graph: ChunkGraph, roots: string[]): Set<string> => {
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const imported of graph.getModuleInfo(current)?.importedIds ?? []) {
      if (seen.has(imported)) continue;
      seen.add(imported);
      queue.push(imported);
    }
  }
  return seen;
};

const isUiBootModule = (id: string, graph: ChunkGraph): boolean => {
  if (!uiBootModules) {
    const ids = [...graph.getModuleIds()];
    const uiEntry = ids.filter((moduleId) => normalizeModuleId(moduleId).endsWith(WORKSPACE_UI_ENTRY));
    const shells = ids.filter((moduleId) => HTML_ENTRY_SHELLS.includes(normalizeModuleId(moduleId)));
    const boot = collectStaticGraph(graph, uiEntry);
    for (const shellModule of collectStaticGraph(graph, shells)) boot.delete(shellModule);
    uiBootModules = boot;
  }
  return uiBootModules.has(id);
};

const bootVendorGraphPlugin = () => ({
  name: 'pichamber-boot-vendor-graph',
  buildStart() {
    uiBootModules = null;
  },
});

const themeJsonHmrPlugin = () => ({
  name: 'pichamber-theme-json-hmr',
  handleHotUpdate({ file, server }: { file: string; server: { ws: { send: (payload: unknown) => void } } }) {
    if (!file.startsWith(`${themeDirectory}${path.sep}`) || path.extname(file) !== '.json') {
      return;
    }

    try {
      server.ws.send({
        type: 'custom',
        event: 'pichamber:theme-updated',
        data: JSON.parse(readFileSync(file, 'utf-8')),
      });
      // Theme JSON is applied by the runtime event listener. Returning no
      // modules prevents Vite's otherwise unavoidable page-reload fallback.
      return [];
    } catch {
      // Leave the previous valid theme active while an editor writes invalid
      // or incomplete JSON; the next valid save will replace it.
      return [];
    }
  },
});

export default defineConfig({
  root: path.resolve(__dirname, '.'),
  plugins: [
    react(
      enableReactCompiler
        ? {
            babel: {
              plugins: ['babel-plugin-react-compiler'],
            },
          }
        : undefined,
    ),
    {
      name: 'inject-react-scan-script',
      transformIndexHtml() {
        if (!enableReactScan) {
          return;
        }
        return [
          {
            tag: 'script',
            attrs: {
              crossorigin: 'anonymous',
              src: '//unpkg.com/react-scan/dist/auto.global.js',
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
    themeStoragePlugin(),
    themeJsonHmrPlugin(),
    bootVendorGraphPlugin(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,ttf,otf,eot}'],
        // iOS Safari/PWA is much more reliable with a classic (non-module) SW bundle.
        rollupFormat: 'iife',
        // We already keep a custom manifest in index.html
        injectionPoint: undefined,
      },
      devOptions: {
        enabled: pwaDevEnabled,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: [
      // `@pierre/diffs` exposes its patch parser only through the package root,
      // which also re-exports the Shiki-backed renderer. Tool rows in every
      // transcript only parse patches, so they import the parser module
      // directly (dependencies: constants and two string helpers) and Shiki
      // stays out of the startup graph. Mirrored in the ui/web tsconfig paths.
      {
        find: /^@pichamber\/pierre-parse-patch$/,
        replacement: path.resolve(__dirname, '../ui/node_modules/@pierre/diffs/dist/utils/parsePatchFiles.js'),
      },
      { find: '@pichamber/ui', replacement: path.resolve(__dirname, '../ui/src') },
      { find: '@web', replacement: path.resolve(__dirname, './src') },
      { find: '@', replacement: path.resolve(__dirname, '../ui/src') },
    ],
  },
  worker: {
    format: 'es',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    port: 5173,
    // Dev-only: pre-transform the app graph while the server idles. The shared
    // UI entry is dynamically imported by main.tsx, so it must be listed
    // explicitly or the first page load compiles ~900 modules on demand.
    warmup: {
      clientFiles: ['./src/main.tsx', '../ui/src/main.tsx'],
    },
    proxy: {
      '/auth': {
        target: `http://127.0.0.1:${process.env.PICHAMBER_PORT || 3001}`,
        changeOrigin: true,
        configure: forwardBrowserHost,
      },
      '/health': {
        target: `http://127.0.0.1:${process.env.PICHAMBER_PORT || 3001}`,
        changeOrigin: true,
      },
      '/api': {
        target: `http://127.0.0.1:${process.env.PICHAMBER_PORT || 3001}`,
        changeOrigin: true,
        configure: forwardBrowserHost,
        // The development proxy changes the upstream Host to the loopback API
        // target. Rewrite WebSocket Origin to the same target so authenticated
        // upgrade checks do not reject HMR clients running on a different port.
        rewriteWsOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        mobile: path.resolve(__dirname, 'mobile.html'),
        miniChat: path.resolve(__dirname, 'mini-chat.html'),
      },
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        manualChunks(id, graph) {
          // Pin Vite's tiny runtime helpers to their own stable chunk. Otherwise
          // Rollup co-locates the `__vitePreload` helper into an arbitrary vendor
          // chunk (e.g. `shiki`), and since every dynamic import pulls the helper,
          // that whole vendor (here Shiki core + the 629KB oniguruma engine) gets
          // dragged into the eager bootstrap graph.
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'vendor-vite-runtime';
          }
          if (!id.includes('node_modules')) return undefined;

          // Resolve the real package from the LAST `node_modules/` segment.
          // bun's isolated install nests packages as
          // `node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/...`, so the first
          // `node_modules/` segment is `.bun` — using it collapses every dependency
          // (incl. lazy-only ones) into a single giant eager `vendor-.bun` chunk.
          const lastNodeModules = id.lastIndexOf('node_modules/');
          const match = id.slice(lastNodeModules + 'node_modules/'.length);
          if (!match) return undefined;

          const segments = match.split('/');
          const packageName = match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];

          // Shiki grammars/themes and CodeMirror legacy modes are dynamically
          // imported one at a time by their registries. Forcing them into a
          // single vendor chunk makes the first language request download every
          // grammar (7.4 MB raw for @shikijs/langs). Let Rollup split them per
          // dynamically imported module so only used languages are fetched —
          // the worker build already behaves this way.
          if (
            packageName === '@shikijs/langs' ||
            packageName === '@shikijs/themes' ||
            packageName === '@codemirror/legacy-modes'
          ) {
            return undefined;
          }

          // Split @pierre/diffs by usage as well: the eager tool renderer needs
          // only its pure patch parser, while the Shiki-importing render stack
          // must stay loadable on demand. One merged vendor chunk would make
          // the parser import download the whole stack eagerly.
          if (packageName === '@pierre/diffs') {
            return undefined;
          }

          // Every package the workspace UI needs at boot shares one chunk. Split
          // per package, the boot graph was ~75 separate vendor requests, which
          // the browser resolves over at most six HTTP/1.1 connections: ~0.6s
          // of a cold start at 50ms RTT and ~150ms of a cached reload. Lazy-only
          // packages keep their per-package chunks below.
          if (!/\.css(?:$|\?)/.test(id) && isUiBootModule(id, graph)) return 'vendor-boot';

          if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react';
          if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand';

          if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown';
          if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui';

          const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-');
          // Give package stylesheets their own CSS-only chunk. Sharing the
          // package's vendor chunk turns a static `import 'pkg/x.css'` into an
          // import of that whole vendor JS chunk, so the terminal stylesheet
          // dragged xterm.js into the startup graph even though the emulator
          // itself is loaded on demand.
          if (/\.css(?:$|\?)/.test(id)) return `vendor-${sanitized}-css`;
          return `vendor-${sanitized}`;
        },
      },
    },
  },
});
