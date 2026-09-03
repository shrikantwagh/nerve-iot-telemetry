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
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
})
