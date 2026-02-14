---
name: prisma-server
description: Use this when working with database operations in the server component. Covers Prisma patterns, transactions, and event handling.
---

## Use this when

- Working with database operations in `/server`
- Adding new database queries or mutations
- Handling transactions and events

## Prisma basics

- Prisma is used as ORM
- Use `inTx` wrapper for transactions
- Use `@/` prefix for all imports

```typescript
import { db } from '@/storage/db'
import { inTx } from '@/storage/inTx'
```

## Transaction pattern

```typescript
import { inTx } from '@/storage/inTx'

const result = await inTx(async (tx) => {
    const user = await tx.user.create({ data: { ... } })
    await tx.session.create({ data: { userId: user.id, ... } })
    return user
})
```

## Event emission

Use `afterTx` to send events after transaction commits:

```typescript
import { afterTx } from '@/storage/afterTx'

await inTx(async (tx) => {
    const session = await tx.session.create({ ... })
    afterTx(() => {
        eventbus.emit('new-session', session)
    })
    return session
})
```

## Schema changes

- NEVER create migrations yourself
- Only run `yarn generate` when new types are needed
- For complex fields, use `Json` type
- Do not update schema without absolute necessity

## Idempotency

Design all operations to be idempotent - clients may retry requests automatically:

```typescript
// Good: Use upsert or findFirst before create
const existing = await tx.session.findFirst({
    where: { tag, userId }
})
if (existing) return existing

return tx.session.create({ ... })
```

## Quick checklist

- Use `inTx` for all database operations
- Use `afterTx` for event emission
- Design idempotent operations
- Never create migrations manually
- Use `@/` import prefix
