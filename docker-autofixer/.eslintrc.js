module.exports = {
  env: {
    node: true,
    es6: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'script', // Use script for CommonJS
  },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'off', // Allow console in server code
  },
  globals: {
    process: 'readonly',
    global: 'readonly',
    Buffer: 'readonly',
    setImmediate: 'readonly',
    clearImmediate: 'readonly',
  },
};
