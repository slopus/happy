// Legacy ESLint config - using older version for compatibility
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  plugins: [
    'react',
    'react-hooks',
    '@typescript-eslint',
  ],
  rules: {
    // TypeScript specific rules
    '@typescript-eslint/no-unused-vars': ['warn', {
      'varsIgnorePattern': '^_',
      'argsIgnorePattern': '^_',
      'destructuredArrayIgnorePattern': '^_'
    }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-empty-function': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',

    // React specific rules
    'react/prop-types': 'off', // Using TypeScript for prop validation
    'react/react-in-jsx-scope': 'off', // Not needed in React 17+
    'react/display-name': 'warn',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',

    // General JavaScript rules
    'no-console': 'warn',
    'no-debugger': 'error',
    'no-alert': 'warn',
    'no-unused-vars': 'off', // Use TypeScript version instead
    'prefer-const': 'error',
    'no-var': 'error',
    'object-shorthand': 'warn',
    'prefer-template': 'warn',

    // Code style rules - matching project conventions
    'indent': ['error', 2, { 'SwitchCase': 1 }],
    'quotes': ['error', 'single', { 'allowTemplateLiterals': true }],
    'semi': ['error', 'always'],
    'comma-dangle': ['error', 'always-multiline'], // Allow trailing commas
    'object-curly-spacing': ['error', 'always'],
    'array-bracket-spacing': ['error', 'never'],
    'space-before-blocks': 'error',
    'keyword-spacing': 'error',
  },
  env: {
    es6: true,
    node: true,
    browser: true,
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    'android/',
    'ios/',
    '.expo/',
    '*.d.ts',
  ],
};