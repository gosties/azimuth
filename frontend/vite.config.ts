import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig(({mode}) => ({
  plugins: [react(), {
    name: 'explicit-canvas-readback-hint',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/ol/render/canvas/ExecutorGroup.js')) return
      // OpenLayers benchmarks unspecified, CPU and GPU contexts. Chromium warns
      // on the unspecified case, so benchmark the two explicit modes instead.
      const unspecified = /^\s*\[measure\(undefined\)\]: undefined,\r?$/m
      return unspecified.test(code) ? code.replace(unspecified, '') : undefined
    },
  }],
  server: {
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url)),
      fileURLToPath(new URL('../src/h3search/api/map_grid.sql', import.meta.url)),
      fileURLToPath(new URL('../src/h3search/api/map_grid.sql', import.meta.url)) + '?raw'] },
    proxy: { '/api': loadEnv(mode, process.cwd(), '').H3SEARCH_DEV_API_TARGET || 'http://127.0.0.1:8166' },
  },
}))
