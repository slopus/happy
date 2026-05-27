import { Context } from "@/context";
import { inTx } from "@/storage/inTx";

/**
 * Update the caller's account profile metadata (username, firstName,
 * lastName). Only fields present in `params` are touched — undefined keys
 * are preserved. Idempotent: passing values already on the row is a no-op.
 *
 * Why: happy-server's auth.upsert (authRoutes.ts) only stores publicKey,
 * so Account.username is null for every locally-registered user. The
 * web-ui calls this on login + on company-context switch to keep the
 * Account row in sync with users.json / companies.json.
 *
 * Validation:
 * - `username` must match /^[a-zA-Z0-9_-]+$/ and be 1–40 chars.
 * - `username` must not be already in use by a different *active* Account
 *   (Account.username is @unique). Stale holders — rows with zero sessions
 *   AND zero machines — are taken over automatically (specs/20260527-
 *   happy-account-username-cleanup option B). Active holders still get
 *   `'username-taken'` so the route can return 409 + a clean toast.
 *
 * Returns the updated firstName/lastName/username/avatar/githubUser
 * snapshot — the route layer wraps this with timestamp/connectedServices
 * to match GET /v1/account/profile's response shape.
 */
export type AccountUpdateProfileError = "username-taken" | "invalid-username";

export type AccountUpdateProfileResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: AccountUpdateProfileError };

export interface AccountSnapshot {
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: unknown;
    githubUser: { profile: unknown } | null;
}

export interface AccountUpdateProfileParams {
    username?: string;
    firstName?: string;
    lastName?: string;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const USERNAME_MIN = 1;
const USERNAME_MAX = 40;

export async function accountUpdateProfile(
    ctx: Context,
    params: AccountUpdateProfileParams
): Promise<AccountUpdateProfileResult<AccountSnapshot>> {
    if (params.username !== undefined) {
        if (
            params.username.length < USERNAME_MIN ||
            params.username.length > USERNAME_MAX ||
            !USERNAME_PATTERN.test(params.username)
        ) {
            return { ok: false, error: "invalid-username" };
        }
    }

    return await inTx(async (tx) => {
        const current = await tx.account.findUnique({
            where: { id: ctx.uid },
            include: { githubUser: true }
        });
        // Auth middleware guarantees the row exists, so a missing row
        // indicates a deeper auth bug — let it surface as a 500.
        if (!current) {
            throw new Error(`account ${ctx.uid} not found`);
        }

        const data: AccountUpdateProfileParams = {};
        if (params.username !== undefined && params.username !== current.username) {
            data.username = params.username;
        }
        if (params.firstName !== undefined && params.firstName !== current.firstName) {
            data.firstName = params.firstName;
        }
        if (params.lastName !== undefined && params.lastName !== current.lastName) {
            data.lastName = params.lastName;
        }

        if (Object.keys(data).length === 0) {
            return {
                ok: true,
                value: snapshot(current)
            } as const;
        }

        if (data.username !== undefined) {
            const taken = await tx.account.findFirst({
                where: { username: data.username, NOT: { id: ctx.uid } },
                select: { id: true }
            });
            if (taken) {
                // Option B: take over the username when the holding row is
                // stale (zero sessions, zero machines). Active rows keep the
                // username and the caller still gets 'username-taken'. See
                // specs/20260527-happy-account-username-cleanup §4.2.
                const [sessionCount, machineCount] = await Promise.all([
                    tx.session.count({ where: { accountId: taken.id } }),
                    tx.machine.count({ where: { accountId: taken.id } })
                ]);
                if (sessionCount > 0 || machineCount > 0) {
                    return { ok: false, error: "username-taken" } as const;
                }
                await tx.account.update({
                    where: { id: taken.id },
                    data: { username: null }
                });
            }
        }

        const updated = await tx.account.update({
            where: { id: ctx.uid },
            data,
            include: { githubUser: true }
        });

        return {
            ok: true,
            value: snapshot(updated)
        } as const;
    });
}

function snapshot(row: {
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: unknown;
    githubUser: { profile: unknown } | null;
}): AccountSnapshot {
    return {
        firstName: row.firstName,
        lastName: row.lastName,
        username: row.username,
        avatar: row.avatar,
        githubUser: row.githubUser
    };
}
