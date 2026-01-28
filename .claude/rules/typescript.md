---
paths:
- "**/*.ts"
- "**/*.tsx"
---

# TypeScript Rules

## Type Safety

### Strict Mode
- **Strict mode enabled** - All components run with `strict: true` in tsconfig.json
- **All files must pass** `yarn typecheck` or `tsc --noEmit`
- **No untyped code** - "I despise untyped code"

### Type Annotations
- **Explicit return types** - All functions must have explicit return type annotations
- **Explicit parameter types** - All function parameters must be typed
- **No `any` types** - Use `unknown` instead of `any`
- **Prefer interfaces** - Use interfaces over types for object shapes
- **Use type guards** - For runtime type checking

### Type Imports
- **Use `import type`** for type-only imports
- **Use `@/` alias** for src imports (configured per component)

## Component-Specific TypeScript

### CLI
- **Clean function signatures** - Explicit parameter and return types
- **Comprehensive JSDoc comments** - Each file includes header comments explaining responsibilities
- **Type checking**: `yarn typecheck` runs TypeScript compiler check

### Expo App
- **Strict mode enforced** - All code must be properly typed
- **Path alias** - `@/*` maps to `./sources/*`
- **Type checking**: `yarn typecheck` after all changes

### Server
- **Type-safe routing** - fastify-type-provider-zod for compile-time and runtime validation
- **Zod schemas** - For all route validation
- **Type checking**: `yarn build` runs TypeScript type checking (no emit)

## Best Practices

### Avoiding `any`
```typescript
// ❌ Bad
function foo(data: any) {
    return data.bar;
}

// ✅ Good
function foo(data: unknown) {
    if (typeof data === 'object' && data !== null && 'bar' in data) {
        return (data as { bar: string }).bar;
    }
    throw new Error('Invalid data');
}
```

### Type Guards
```typescript
function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function process(value: unknown) {
    if (isString(value)) {
        // TypeScript knows value is string here
        console.log(value.toUpperCase());
    }
}
```

### Type Imports
```typescript
// ✅ Good - Type-only import
import type { Foo } from './foo';
import { Bar } from './bar';

// ❌ Bad - Mixed import
import { Foo, Bar } from './bar';
```

## Running Type Checks

### CLI
```bash
cd cli
yarn typecheck          # Run TypeScript compiler check
```

### Expo App
```bash
cd expo-app
yarn typecheck          # Run TypeScript type checking after all changes
```

### Server
```bash
cd server
yarn build              # TypeScript type checking (no emit)
```

## See Also

- Code style guidelines: @.claude/rules/code-style.md
- Testing guidelines: @.claude/rules/testing.md
- Component-specific TypeScript: @cli/CLAUDE.md, @expo-app/CLAUDE.md, @server/CLAUDE.md
