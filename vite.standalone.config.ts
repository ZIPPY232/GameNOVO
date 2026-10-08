import { defineConfig, mergeConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import base from './vite.config';

// Single self-contained HTML (scripts, styles, fonts and the worker inlined):
// opens with a double click from disk and is what the desktop app loads.
export default mergeConfig(base, defineConfig({
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  worker: { format: 'iife' },
  build: { outDir: 'dist-standalone', assetsInlineLimit: 100_000_000, cssCodeSplit: false },
}));
