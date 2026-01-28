# Code Style Guidelines

## Universal Rules (All Components)

### Indentation & Formatting
- **Indentation**: 4 spaces (not 2 spaces)
- **No trailing whitespace**
- **Unix line endings (LF)**

### TypeScript
- **Strict mode enabled** - All components enforce strict typing
- **Use `@/` alias** for src imports (configured separately per component)
- **Named exports preferred** - Default exports only for main functions
- **Explicit return types** - All functions should have explicit return type annotations

### Code Patterns
- **Prefer functional programming** - Avoid classes
- **Keep it simple** - Avoid over-engineering
- **Files**: Unless absolutely necessary, do not create new files
- **ALWAYS prefer editing existing files** over creating new ones

### Package Management
- **Use yarn, not npm** - All components use yarn workspaces
- **Yarn version**: 1.22.22

### Comments
- **Add documentation comments** that explain logic after writing actions
- **No unnecessary comments** - Code should be self-explanatory
- **Usernames**: Always use GitHub usernames when referencing users

### Error Handling
- **Graceful error handling** with proper error messages
- **Never show loading errors** to users - always retry silently
- **Centralized error handlers** - Use existing error handling infrastructure

## Project-Specific Conventions

### CLI (happy-cli)
- **Clean function signatures** - Explicit parameter and return types
- **Comprehensive JSDoc comments** - Each file includes header comments explaining responsibilities
- **File-based logging** - Prevents interference with agent terminal UIs

### Expo App (expo-app)
- **Use Unistyles** - Cross-platform styling with themes and breakpoints
- **i18n required** - Use `t()` function for all user-visible strings
- **Put styles at end** - Always put styles at very end of component files
- **Wrap pages in memo** - All pages should be wrapped in React.memo

### Server (happy-server)
- **Action files**: Create dedicated files in relevant `sources/app/` subfolders (e.g., `sessionAdd.ts`, `friendRemove.ts`)
- **Return only essential data** - Don't return values "just in case"
- **Do not add logging** when not asked
- **Directory naming**: Lowercase with dashes (e.g., `components/auth-wizard`)

## File Organization

### Naming Conventions
- **Utility files**: Name file and function the same way for easy discovery
- **Test files**: Same name as source with `.test.ts` or `.spec.ts` suffix
- **Action files**: Prefix with entity type then action (e.g., `sessionAdd.ts`)

### Documentation
- **NEVER proactively create documentation files (*.md)** unless explicitly requested
- **When using prompts**: Write prompts to `_prompts.ts` file relative to the application

## Cryptography

### Encoding/Decoding
- **CLI**: Use encryption utilities in `src/api/encryption.ts`
- **Server**: Always use `privacyKit.decodeBase64` and `privacyKit.encodeBase64` from privacy-kit instead of Buffer directly
- **Mobile**: Use `@more-tech/react-native-libsodium`

## Testing

### Universal Testing Principles
- **TDD for utility functions** - Write tests BEFORE implementation
- **Integration tests for features** - Test real workflows
- **No mocking** - Tests make real API calls
- **Test location**: Same directory as source, with `.test.ts` or `.spec.ts` suffix

See @.claude/rules/testing.md for detailed testing guidelines.

## Language-Specific Rules

See @.claude/rules/typescript.md for TypeScript-specific rules.
See @.claude/rules/react-native.md for React Native-specific rules.
See @.claude/rules/server.md for Server-specific rules.
