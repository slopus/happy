import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock inTx so the action runs against an in-memory fake tx.
let currentTx: any = null;
vi.mock("@/storage/inTx", () => ({
    inTx: (fn: (tx: any) => Promise<unknown>) => fn(currentTx)
}));

import { accountUpdateProfile } from "./accountUpdateProfile";

function makeCtx(uid: string) {
    return { uid } as any;
}

function makeAccount(overrides: Partial<{
    id: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
}> = {}) {
    return {
        id: "user-1",
        username: null,
        firstName: null,
        lastName: null,
        avatar: null,
        githubUser: null,
        ...overrides
    };
}

describe("accountUpdateProfile", () => {
    beforeEach(() => {
        currentTx = null;
    });

    it("updates only the username when only username is provided (other fields preserved)", async () => {
        // Why: PATCH semantics — fields not in the body must not be cleared.
        // The web-ui's login-time backfill only sends `username`; if the action
        // accidentally nulled firstName/lastName, GitHub-OAuth users (who
        // already have those filled in) would lose their names on every login.
        currentTx = {
            account: {
                findUnique: vi.fn().mockResolvedValue(makeAccount({ id: "user-1", firstName: "Alice", lastName: "Lee" })),
                findFirst: vi.fn().mockResolvedValue(null),
                update: vi.fn().mockImplementation(({ where, data }) =>
                    Promise.resolve(makeAccount({ id: where.id, firstName: "Alice", lastName: "Lee", username: data.username }))
                ),
            }
        };

        const result = await accountUpdateProfile(makeCtx("user-1"), { username: "alice" });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.username).toBe("alice");
        expect(result.value.firstName).toBe("Alice");
        expect(result.value.lastName).toBe("Lee");

        const updateCall = currentTx.account.update.mock.calls[0][0];
        expect(updateCall.data).toEqual({ username: "alice" });
        expect(updateCall.data).not.toHaveProperty("firstName");
        expect(updateCall.data).not.toHaveProperty("lastName");
    });

    it("is idempotent — passing the same username already on the row is a no-op", async () => {
        // Why: web-ui calls this on every login + every company-context switch.
        // Without short-circuit, every navigation would touch the row + trigger
        // a unique-constraint check (cheap but pointless). More importantly,
        // it must not return an error when the value is already correct.
        currentTx = {
            account: {
                findUnique: vi.fn().mockResolvedValue(makeAccount({ username: "alice" })),
                findFirst: vi.fn(),
                update: vi.fn(),
            }
        };

        const result = await accountUpdateProfile(makeCtx("user-1"), { username: "alice" });

        expect(result).toEqual({
            ok: true,
            value: expect.objectContaining({ username: "alice" })
        });
        expect(currentTx.account.update).not.toHaveBeenCalled();
        expect(currentTx.account.findFirst).not.toHaveBeenCalled();
    });

    it("returns 'username-taken' when another *active* account owns the requested username", async () => {
        // Why: Account.username is @unique. If we let the update through, the
        // DB would throw P2002 and the route would 500 — the client could not
        // distinguish that from a real failure. Fail fast with a structured
        // error so the route can map it to 409 + a clean toast.
        //
        // Active = has sessions or machines. Stale-row takeover is handled by
        // a separate test below (specs/20260527-happy-account-username-cleanup
        // option B). For "active holder" the caller must keep getting 409.
        currentTx = {
            account: {
                findUnique: vi.fn().mockResolvedValue(makeAccount({ username: null })),
                findFirst: vi.fn().mockResolvedValue({ id: "user-2" }),
                update: vi.fn(),
            },
            session: { count: vi.fn().mockResolvedValue(1) },
            machine: { count: vi.fn().mockResolvedValue(0) }
        };

        const result = await accountUpdateProfile(makeCtx("user-1"), { username: "alice" });

        expect(result).toEqual({ ok: false, error: "username-taken" });
        expect(currentTx.account.update).not.toHaveBeenCalled();
    });

    it("takes over the username from a stale row (no sessions, no machines)", async () => {
        // Why: specs/20260527-happy-account-username-cleanup option B.
        // When the holding row has zero sessions AND zero machines, it is a
        // leftover from a prior publicKey/registration that nobody can claim
        // anymore. The current caller — already authenticated via app.authenticate
        // — gets to take the username over. Active rows are NOT touched
        // (covered by the previous test).
        const sessionCount = vi.fn().mockResolvedValue(0);
        const machineCount = vi.fn().mockResolvedValue(0);
        const updateMock = vi.fn().mockImplementation(({ where, data }) => {
            if (where.id === "user-2") {
                return Promise.resolve(makeAccount({ id: "user-2", username: data.username ?? null }));
            }
            return Promise.resolve(makeAccount({ id: where.id, username: data.username ?? null }));
        });
        currentTx = {
            account: {
                findUnique: vi.fn().mockResolvedValue(makeAccount({ id: "user-1", username: null })),
                findFirst: vi.fn().mockResolvedValue({ id: "user-2" }),
                update: updateMock,
            },
            session: { count: sessionCount },
            machine: { count: machineCount }
        };

        const result = await accountUpdateProfile(makeCtx("user-1"), { username: "alice" });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.username).toBe("alice");

        // The stale row's username is cleared first…
        expect(sessionCount).toHaveBeenCalledWith({ where: { accountId: "user-2" } });
        expect(machineCount).toHaveBeenCalledWith({ where: { accountId: "user-2" } });
        expect(updateMock).toHaveBeenNthCalledWith(1, {
            where: { id: "user-2" },
            data: { username: null }
        });
        // …then the caller's row picks it up.
        const lastCall = updateMock.mock.calls.at(-1)![0];
        expect(lastCall.where).toEqual({ id: "user-1" });
        expect(lastCall.data).toEqual({ username: "alice" });
    });

    it("rejects 'invalid-username' for characters outside [a-zA-Z0-9_-] or out-of-range length", async () => {
        // Why: defensive gate even though the web-ui pre-validates. Stops a
        // misbehaving client from poisoning the column with whitespace,
        // pipes, or 5KB blobs that would later break URL building.
        currentTx = {
            account: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                update: vi.fn(),
            }
        };

        const cases = ["bad name", "with$pecial", "", "x".repeat(41)];
        for (const username of cases) {
            const result = await accountUpdateProfile(makeCtx("user-1"), { username });
            expect(result).toEqual({ ok: false, error: "invalid-username" });
        }
        expect(currentTx.account.update).not.toHaveBeenCalled();
        expect(currentTx.account.findUnique).not.toHaveBeenCalled();
    });

    it("updates firstName/lastName without touching username's uniqueness check", async () => {
        // Why: company-context backfill sends only `firstName: displayName`.
        // The unique-username probe is only relevant when username itself
        // changes — running it for every PATCH would waste a query.
        currentTx = {
            account: {
                findUnique: vi.fn().mockResolvedValue(makeAccount({ username: "alice", firstName: null })),
                findFirst: vi.fn(),
                update: vi.fn().mockImplementation(({ where, data }) =>
                    Promise.resolve(makeAccount({ id: where.id, username: "alice", firstName: data.firstName, lastName: data.lastName ?? null }))
                ),
            }
        };

        const result = await accountUpdateProfile(makeCtx("user-1"), { firstName: "Buzzni" });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.firstName).toBe("Buzzni");
        expect(currentTx.account.findFirst).not.toHaveBeenCalled();

        const updateCall = currentTx.account.update.mock.calls[0][0];
        expect(updateCall.data).toEqual({ firstName: "Buzzni" });
    });
});
