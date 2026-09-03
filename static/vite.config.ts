import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so the bundle works whether the host serves it from the root or a
  // sub-path. Combined with HashRouter this makes deep links survive any static host,
  // including ones with no history-fallback rewrite (Xano's does not document one).
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Recharts + React is the bulk of the bundle; splitting it keeps the app chunk
    // small enough that a redeploy does not invalidate everything.
    //
    // Vite 8 bundles with rolldown, whose `manualChunks` is the function form only —
    // the old `{ name: [...packages] }` record is no longer accepted. Matching on the
    // resolved module id gets each library *and its private dependencies* into the
    // right chunk (react-router pulls in cookie/set-cookie-parser, recharts pulls in
    // the d3-* family), which the record form never did.
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules[\\/](?:react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
            return 'react'
          if (/node_modules[\\/](?:recharts|recharts-scale|d3-[^\\/]+|internmap|victory-vendor|decimal\.js-light|fast-equals|eventemitter3|use-sync-external-store)[\\/]/.test(id))
            return 'charts'
          return undefined
        },
      },
    },
  },
})
