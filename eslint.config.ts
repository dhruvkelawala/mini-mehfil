import { fileURLToPath } from 'node:url';

import eslint from '@eslint/js';
import solid from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// fileURLToPath, not URL.pathname: a checkout path holding a space arrives
// percent-encoded from pathname, and TypeScript then cannot find the configs.
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'plans/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      'api/**/*.ts',
      'scripts/**/*.ts',
      'test/**/*.ts',
      'test/**/*.tsx',
    ],
  })),
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      'api/**/*.ts',
      'scripts/**/*.ts',
      'test/**/*.ts',
      'test/**/*.tsx',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    ...solid,
    files: [
      'src/client/**/*.ts',
      'src/client/**/*.tsx',
      'test/client/**/*.ts',
      'test/client/**/*.tsx',
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.client.json'],
        tsconfigRootDir: projectRoot,
      },
    },
  },
  {
    files: [
      'eslint.config.ts',
      'vite.config.ts',
      'vitest*.config.ts',
      'playwright.config.ts',
      'scripts/**/*.ts',
      'src/server/**/*.ts',
      'api/**/*.ts',
      'test/**/*.ts',
      'test/**/*.tsx',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/server/**/*.ts', 'api/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.node.json'],
        tsconfigRootDir: projectRoot,
      },
    },
  },
  {
    files: ['test/server/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['src/room/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../client/**',
                '../server/**',
                '../worker/**',
                '../../src/client/**',
                '../../src/server/**',
                '../../src/worker/**',
              ],
              message: 'The room core must remain platform-independent.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/worker/**/*.ts', 'test/worker/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.worker.json'],
        tsconfigRootDir: projectRoot,
      },
    },
  },
  {
    files: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['test/server/server.test.ts', 'test/worker/sharing.test.ts'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
);
