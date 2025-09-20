// Legacy ESLint config - using older version for compatibility
module.exports = {
	root: true,
	parser: "@typescript-eslint/parser",
	parserOptions: {
		ecmaFeatures: {
			jsx: true,
		},
		ecmaVersion: 2020,
		sourceType: "module",
	},
	plugins: ["react", "react-hooks", "@typescript-eslint"],
	rules: {
		// TypeScript specific rules - relaxed for development
		"@typescript-eslint/no-unused-vars": "off", // Too many false positives in development
		"@typescript-eslint/no-explicit-any": "off", // Allow any for rapid development
		"@typescript-eslint/explicit-function-return-type": "off",
		"@typescript-eslint/explicit-module-boundary-types": "off",
		"@typescript-eslint/no-empty-function": "off", // Allow empty functions for placeholders
		"@typescript-eslint/no-non-null-assertion": "off", // Allow ! operator when needed

		// React specific rules
		"react/prop-types": "off", // Using TypeScript for prop validation
		"react/react-in-jsx-scope": "off", // Not needed in React 17+
		"react/display-name": "off", // Not critical for this project
		"react-hooks/rules-of-hooks": "error", // Keep this as error - critical rule
		"react-hooks/exhaustive-deps": "off", // Often too strict for development

		// General JavaScript rules - development-friendly
		"no-console": "off", // Allow console.log for debugging
		"no-debugger": "error", // Still error for debugger statements
		"no-alert": "off", // Allow alerts if needed
		"no-unused-vars": "off", // Use TypeScript version instead
		"prefer-const": "error",
		"no-var": "error",
		"object-shorthand": "off", // Allow both shorthand and regular object syntax
		"prefer-template": "off", // Allow string concatenation

		// Code style rules - matching project conventions
		indent: ["error", 2, { SwitchCase: 1 }],
		quotes: ["error", "single", { allowTemplateLiterals: true }],
		semi: ["error", "always"],
		"comma-dangle": ["error", "always-multiline"], // Allow trailing commas
		"object-curly-spacing": ["error", "always"],
		"array-bracket-spacing": ["error", "never"],
		"space-before-blocks": "error",
		"keyword-spacing": "error",
	},
	env: {
		es6: true,
		node: true,
		browser: true,
	},
	settings: {
		react: {
			version: "detect",
		},
	},
	ignorePatterns: [
		"node_modules/",
		"dist/",
		"build/",
		"android/",
		"ios/",
		".expo/",
		"*.d.ts",
		"sources/trash/", // Ignore test/example files
	],
};
