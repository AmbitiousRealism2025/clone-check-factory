import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/js/**/*.js'],
      exclude: [
        'src/js/search.js',
        'src/js/trending.js',
        'src/js/favorites.js',
        'src/js/detail.js',
        'src/js/collections.js',
        'src/js/compare.js',
        'src/js/errorBoundary.js'
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    },
    include: ['src/**/*.test.js', 'mcp/**/*.test.js'],
    // The MCP stdio tests spawn child processes; give them a generous timeout.
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./src/js/__tests__/setup.js']
  }
});
