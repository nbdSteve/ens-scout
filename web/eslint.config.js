import js from '@eslint/js'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'playwright-report', 'test-results', 'node_modules'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'jsx-a11y': jsxA11y },
    // `configs.flat` is the flat-config form; `configs['recommended-latest']`
    // is still the eslintrc shape, whose `plugins` is an array of names.
    extends: [reactHooks.configs.flat['recommended-latest']],
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      // The countdown text updates every second. Announcing it would flood a
      // screen reader, so it is hidden and paired with a static description;
      // aria-hidden on a non-interactive span is the mechanism for that.
      'jsx-a11y/no-aria-hidden-on-focusable': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // The snapshot parser reads untrusted JSON as `Record<string, unknown>`.
      // Bracket access there is the point: it marks every place a value came off
      // the wire and has not been checked yet, which dot access would hide.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
    },
  },
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // Test doubles legitimately narrow structural types the runtime never sees.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['*.config.{ts,js}', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
)
