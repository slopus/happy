// @ts-check
import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import prettierPlugin from "eslint-plugin-prettier";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactNativePlugin from "eslint-plugin-react-native";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

export default [
	{
		ignores: [
			"node_modules/**",
			"android/**",
			"ios/**",
			"dist/**",
			"build/**",
			"coverage/**",
			"src-tauri/target/**",
			".eslintrc.cjs",
			".eslintrc.js",
			"sources/trash/**",
			".github/scripts/**",
			"sources/app/(app)/session/[id]/repository.tsx", // Has many import order issues, skip for now
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.{ts,tsx,js}"],
		plugins: {
			react: reactPlugin,
			"react-hooks": reactHooks,
			"react-native": reactNativePlugin,
			import: importPlugin,
			prettier: prettierPlugin,
			"unused-imports": unusedImports,
		},
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			globals: {
				__DEV__: "readonly",
			},
			parserOptions: {
				ecmaFeatures: { jsx: true },
			},
		},
		rules: {
			"react/react-in-jsx-scope": "off",
			"react/prop-types": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-unused-vars": "off", // Let unused-imports handle this
			"no-case-declarations": "warn",

			// Prettier integration
			"prettier/prettier": ["error", {}, { usePrettierrc: true }],

			// Unused imports auto-removal
			"unused-imports/no-unused-imports": "error",
			"unused-imports/no-unused-vars": [
				"warn",
				{
					vars: "all",
					varsIgnorePattern: "^_",
					args: "after-used",
					argsIgnorePattern: "^_",
				},
			],

			// React Native specific rules
			"react-native/no-unused-styles": "warn",
			"react-native/split-platform-components": "warn",
			"react-native/no-inline-styles": "warn",
			"react-native/no-color-literals": "warn",
			"import/order": [
				"warn",
				{
					"newlines-between": "always",
					groups: [
						"builtin",
						"external",
						"internal",
						"parent",
						"sibling",
						"index",
						"object",
						"type",
					],
					alphabetize: { order: "asc", caseInsensitive: true },
				},
			],
		},
		settings: {
			react: {
				version: "detect",
			},
			"import/resolver": {
				node: { extensions: [".js", ".jsx", ".ts", ".tsx"] },
			},
		},
	},
	// Strict rules for core code (errors)
	{
		files: ["sources/components/**", "sources/sync/**"],
		rules: {
			"@typescript-eslint/no-unused-vars": "error",
			"no-case-declarations": "error",
		},
	},
	// Tests and dev/demo overrides
	{
		files: [
			"**/*.{test,spec}.ts",
			"**/*.{test,spec}.tsx",
			"**/*.integration.test.ts",
			"__tests__/**",
			"sources/app/(app)/dev/**",
		],
		rules: {
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/no-unsafe-function-type": "off",
			"import/order": "warn",
		},
	},
	// Node/JS config files and tooling overrides
	{
		files: [
			"eslint.config.js",
			"babel.config.js",
			"metro.config.js",
			"app.config.js",
			"plugins/**/*.js",
		],
		languageOptions: {
			globals: {
				module: "readonly",
				require: "readonly",
				__dirname: "readonly",
				process: "readonly",
				console: "readonly",
			},
			sourceType: "script",
		},
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			"no-undef": "off",
		},
	},
];
