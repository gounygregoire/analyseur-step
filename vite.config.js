export default {
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
  }
};
