import { defineConfig } from 'vitest/config';

// Tests cover the app's pure TypeScript (lib/) with native modules mocked; screens are not run here.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
