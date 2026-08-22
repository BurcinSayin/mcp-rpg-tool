import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.omc/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': { typescript: { alwaysTryTypes: true } },
    },
  },

  // ---------------------------------------------------------------------------
  // stdout is the JSON-RPC channel. A single console.log corrupts the protocol
  // stream silently and confusingly. Diagnostics go to stderr only.
  // ---------------------------------------------------------------------------
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // Matches the imported binding as well as the global. The previous rule keyed
      // on the global name only, so it was dormant in exactly the files that import
      // node:process -- which are the files where a stdout write would appear.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'stdout',
          message:
            'stdout is the JSON-RPC channel; writing to it corrupts the protocol stream. Use process.stderr.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // AC-24b: src/provider/types.ts must have ZERO imports.
  //
  // Structural, not stylistic: a type file that imports nothing cannot pull in an
  // Elasticsearch client's types, so backend shape physically cannot leak into
  // the shared contract. Stronger than an identifier denylist, which would only
  // be a spelling check -- the real leak would be a SearchQuery shaped
  // { term: {...} } or a `score` field a non-ES backend cannot produce.
  // ---------------------------------------------------------------------------
  {
    files: ['src/provider/types.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration',
          message:
            'AC-24b: src/provider/types.ts must have zero imports. It is the backend-neutral contract; importing anything is how backend semantics leak in.',
        },
        {
          selector: 'TSImportType',
          message: 'AC-24b: no inline import() types in the neutral contract either.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // AC-24a: import zones.
  //
  // Two directions, both enforced:
  //   1. A concrete provider may import only the neutral contract + externals.
  //      (No provider <-> provider coupling.)
  //   2. Nothing outside src/provider/ may import a concrete provider, except
  //      the registry. This is the likelier leak and the earlier revision of the
  //      plan missed it: shared code reaching *into* a provider kills the
  //      abstraction just as dead as provider-to-provider coupling.
  // ---------------------------------------------------------------------------
  {
    files: ['src/**/*.ts'],
    plugins: { import: importPlugin },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/provider/pf2e',
              from: './src/provider/toy',
              message: 'AC-24a: providers must not import each other.',
            },
            {
              target: './src/provider/toy',
              from: './src/provider/pf2e',
              message: 'AC-24a: providers must not import each other.',
            },
            {
              target: './src/tools',
              from: './src/provider/pf2e',
              message:
                'AC-24a: shared code must not reach into a concrete provider. Depend on src/provider/types.ts.',
            },
            {
              target: './src/tools',
              from: './src/provider/toy',
              message:
                'AC-24a: shared code must not reach into a concrete provider. Depend on src/provider/types.ts.',
            },
            {
              target: './src/cache.ts',
              from: './src/provider',
              except: ['./types.ts'],
              message: 'AC-24a: cache is a primitive; providers supply their own key functions.',
            },
            {
              // The neutral contract is exempt on purpose. Depending on it is the
              // intended direction -- it is what every module is supposed to share.
              // What must never happen is a primitive reaching into a *concrete*
              // provider, which is what the zones below the exemption still forbid.
              target: './src/http.ts',
              from: './src/provider',
              except: ['./types.ts'],
              message:
                'AC-24a: http is a primitive. It may depend on the neutral contract, never on a concrete provider.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
