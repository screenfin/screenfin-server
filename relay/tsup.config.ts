import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  // Workspace packages are consumed as TS source, so they must be bundled;
  // published npm deps stay external and are installed in the runtime image.
  noExternal: [/^@screenfin\//],
});
