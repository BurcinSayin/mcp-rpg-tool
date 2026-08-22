import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['test/unit/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['test/setup/no-network.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      include: ['test/integration/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  },
  {
    test: {
      name: 'package',
      include: ['test/package/**/*.test.ts'],
      environment: 'node',
      testTimeout: 180000,
      hookTimeout: 180000,
    },
  },
  {
    test: {
      name: 'live',
      include: ['test/live/**/*.test.ts'],
      environment: 'node',
      testTimeout: 60000,
    },
  },
]);
