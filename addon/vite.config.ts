import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Addon build.
 *
 * Everything the host already provides is marked external: the host loads the
 * addon as an ES module inside its sandbox and supplies React, the SDK, the UI
 * kit and the chart library through an import map. Bundling our own copies
 * would break hooks and double the payload.
 *
 * Note the scaffold's `build.watch` block is deliberately absent — leaving it
 * in makes plain `vite build` never exit. Watch mode is `vite build --watch`,
 * which is what the `dev` script runs.
 */
const hostProvidedDependencies = [
  '@tanstack/react-query',
  '@wealthfolio/addon-sdk',
  '@wealthfolio/addon-sdk/goal-progress',
  '@wealthfolio/addon-sdk/host-api',
  '@wealthfolio/addon-sdk/host-dependencies',
  '@wealthfolio/addon-sdk/manifest',
  '@wealthfolio/addon-sdk/permissions',
  '@wealthfolio/addon-sdk/query-keys',
  '@wealthfolio/addon-sdk/types',
  '@wealthfolio/addon-sdk/utils',
  '@wealthfolio/ui',
  '@wealthfolio/ui/chart',
  'date-fns',
  'lucide-react',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'recharts',
];

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@ui': r('./src/ui'),
      '@services': r('./src/services'),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    // Pinned rather than inherited from Vite. Wealthfolio 3.7 supports Chrome/
    // Edge/WebView2 107, Firefox 104 and Safari/WKWebView 16, and a future Vite
    // default could raise that floor silently — the addon would then break on
    // the oldest WebView Wealthfolio runs on, never on the machine that built
    // it. See docs/addons/addon-migration-guide-v3.6-to-v3.7.md upstream.
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    lib: {
      entry: 'src/addon.tsx',
      fileName: () => 'addon.js',
      formats: ['es'],
    },
    outDir: 'dist',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: hostProvidedDependencies,
      output: {
        // The host loads `dist/addon.js` as a single blob module, so a split
        // chunk would have no resolvable URL. Everything not provided by the
        // host has to land in this one file.
        inlineDynamicImports: true,
      },
    },
  },
});
