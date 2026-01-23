# Testing Guidelines

## Universal Testing Principles

### TDD for Utility Functions
- **Write tests BEFORE implementation** for utility functions
- **Test, implement, iterate** until passing
- **Utility tests** should cover edge cases and error conditions

### Integration Tests for Features
- **Test real workflows** - No mocking of infrastructure
- **Make real API calls** - Tests interact with actual services
- **Test location**: Same directory as source, with `.test.ts` or `.spec.ts` suffix

### Test File Naming
- **CLI**: `.test.ts` suffix (e.g., `lru.test.ts`)
- **Server**: `.spec.ts` suffix (e.g., `lru.spec.ts`)
- **Expo**: `.test.ts` suffix (currently no tests)

## Component-Specific Testing

### CLI Testing
- **Framework**: Vitest
- **No mocking** - Tests make real API calls
- **Descriptive test names** and proper async handling
- **Run tests**: `yarn test` (builds first), `vitest run src/path/to/test.test.ts` for specific files

### Server Testing
- **Framework**: Vitest
- **TDD for utilities** - Write test before implementation
- **Run tests**: `yarn test` (runs all tests), `vitest run sources/path/to/test.spec.ts` for specific files
- **Database**: Use test database, not production

### Expo App Testing
- **Framework**: Vitest
- **Currently no tests** in the codebase
- **Run tests**: `yarn test` (runs in watch mode)

## Test Structure

### Arrange-Act-Assert Pattern
```typescript
describe('functionName', () => {
    it('should do something when condition is met', async () => {
        // Arrange: Set up test data
        const input = { ... };

        // Act: Call function
        const result = await functionName(input);

        // Assert: Verify result
        expect(result).toEqual(expected);
    });
});
```

### Async Testing
- **Always use async/await** for async operations
- **Proper error handling** in tests
- **Cleanup** after tests if needed

## What NOT to Do

- **DO NOT mock** - Tests make real API calls
- **DO NOT skip tests** - All code should be tested
- **DO NOT write tests after implementation** for utilities (TDD approach)
- **DO NOT use test doubles** unless absolutely necessary

## Running Tests

### CLI
```bash
cd cli
yarn test                  # Run all tests (builds first)
yarn build && vitest run   # Run without rebuilding
```

### Server
```bash
cd server
yarn test                  # Run all tests
```

### Expo
```bash
cd expo-app
yarn test                  # Run in watch mode
```

## See Also

Component-specific testing guidelines:
- CLI: @cli/CLAUDE.md
- Server: @server/CLAUDE.md
- Expo: @expo-app/CLAUDE.md
