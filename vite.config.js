import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'static/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/main.js',
      output: {
        entryFileNames: 'main.js',
        assetFileNames: '[name][extname]',
        chunkFileNames: '[name].js'
      }
    }
  },
base: '/',                  // simple et sûr à la racine
})
