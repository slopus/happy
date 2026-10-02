import { PrismaPGlite } from 'pglite-prisma-adapter';

/** Prisma 6's Rust bridge expects JSON arrays for bytea, not typed arrays. */
function normalizeQueryable<T extends { queryRaw: (...args: any[]) => Promise<any> }>(queryable: T): T {
    const query = queryable.queryRaw.bind(queryable);
    queryable.queryRaw = async (...args) => {
        const result = await query(...args);
        result.rows = result.rows.map((row: unknown[]) => row.map(value => value instanceof Uint8Array ? Array.from(value) : value));
        return result;
    };
    return queryable;
}

export class Prisma6PGlite extends PrismaPGlite {
    override async connect() {
        const adapter = normalizeQueryable(await super.connect());
        const start = adapter.startTransaction.bind(adapter);
        adapter.startTransaction = async (...args) => normalizeQueryable(await start(...args));
        return adapter;
    }
}
