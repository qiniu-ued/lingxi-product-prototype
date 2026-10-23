import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist',
    rollupOptions: {
      input: { main: 'src/main.ts', preload: 'src/preload.ts' },
      external: ['electron'],
      output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name].cjs' },
    },
  },
  ssr: { noExternal: ['@lingxi/protocol', 'zod'] },
});
