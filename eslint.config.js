import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'runs/**', 'node_modules/**', '.superpowers/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
