import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // `neutral` keeps `.js` / `.d.ts` (node platform would emit `.mjs`) and the
  // runtime only needs fetch + AbortController, so it also runs on edge runtimes.
  platform: 'neutral',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: 'es2022',
  outDir: 'dist',
  tsconfig: 'tsconfig.build.json',
});
