import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import { bootstrapUserSpace, recordSecurityEvent, SpaceDeletionInProgressError } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./index.js";
import { CLIENT_IP_HEADER, createAuth } from "./index.js";

// Exercise Better Auth's real routing, password hashing, verification and
// session hooks with its official offline adapter. Only persistence is faked.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, { id?: unknown }[]> }) => {
      const factory = memoryAdapter(prisma.authData);
      // Postgres rejects a duplicate primary key, which first-writer-wins reservations rely on.
      return (options: Parameters<typeof factory>[0]) => {
        const adapter = factory(options);
        return {
          ...adapter,
          create: (async (input: { model: string; data: { id?: unknown } }) => {
            const id = input.data.id;
            if (id !== undefined && prisma.authData[input.model]?.some((row) => row.id === id))
              throw new Error("duplicate key");
            return adapter.create(input as never);
          }) as typeof adapter.create,
        };
      };
    },
  };
});
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
  leaveInvitedSpaces: vi.fn(async () => ({ ownedOrganizationIds: [] })),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

function fixture({
  allowlist = "",
  delivery = true,
  baseURL = "http://auth.example.test",
  webOrigin = "http://web.example.test",
  requestOrigin,
  stalledDelivery = false,
  ...hooks
}: {
  allowlist?: string;
  delivery?: boolean;
  baseURL?: string;
  webOrigin?: string;
  requestOrigin?: string;
  /** The provider accepts the message but never settles, like a hung SMTP connection. */
  stalledDelivery?: boolean;
} & Pick<
  AuthEnv,
  "singleAccount" | "afterDeleteSession" | "afterReplaceSession" | "beforeDeleteUser" | "analytics"
> = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    passkey: [],
  };
  const policy: {
    signupsEnabled: boolean;
    signupAllowlist: string;
    signupPolicyInitialized: boolean;
    ownerUserId: string | null;
  } = {
    signupsEnabled: true,
    signupAllowlist: allowlist,
    signupPolicyInitialized: true,
    ownerUserId: null,
  };
  const messages: TransactionalEmail[] = [];
  const members = new Set<string>();
  const prisma = {
    authData: data,
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(
      async (run: ((tx: typeof prisma) => Promise<unknown>) | Promise<unknown>[]) =>
        Array.isArray(run) ? Promise.all(run) : run(prisma),
    ),
    deploymentSettings: {
      findUnique: vi.fn(async () => policy),
      updateMany: vi.fn(async ({ data: patch }: { data: { ownerUserId: string } }) => {
        if (policy.ownerUserId !== null) return { count: 0 };
        policy.ownerUserId = patch.ownerUserId;
        return { count: 1 };
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        const user = data.user!.find((row) => row.id === where.id || row.email === where.email);
        return user ? { locale: user.locale ?? null } : null;
      }),
      findMany: vi.fn(async ({ where }: { where?: { id?: { not?: string } } } = {}) =>
        data
          .user!.filter(
            (user) =>
              user.id !== where?.id?.not &&
              !String(user.email).toLowerCase().endsWith("@messaging.invalid"),
          )
          .slice(0, 2)
          .map((user) => ({ id: String(user.id) })),
      ),
      findFirst: vi.fn(async ({ where }: { where?: { id?: { not?: string } } }) => {
        const excluded = where?.id?.not;
        const other = data.user!.find(
          (user) =>
            (excluded === undefined || user.id !== excluded) &&
            !String(user.email).toLowerCase().endsWith("@messaging.invalid"),
        );
        return other ? { id: String(other.id) } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data: patch,
        }: {
          where: { id: string };
          data: { emailVerified: boolean };
        }) => {
          const user = data.user!.find((item) => item.id === where.id);
          if (!user) return { count: 0 };
          Object.assign(user, patch);
          return { count: 1 };
        },
      ),
    },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    account: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    userDevice: { updateMany: vi.fn(async () => ({ count: 0 })) },
    passkey: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const rows = data.passkey!;
        const kept = rows.filter((row) => row.userId !== where.userId);
        const count = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return { count };
      }),
    },
    organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string | { in: string[] } } }) => {
        const ids = typeof where.userId === "string" ? [where.userId] : where.userId.in;
        const userId = ids.find((id) => members.has(id));
        return userId ? { spaceId: "space-1", userId } : null;
      }),
    },
  };
  vi.mocked(bootstrapUserSpace).mockImplementation(async (_prisma, user) => {
    members.add(user.id);
    return { spaceId: "space-1" };
  });
  const secret = "offline-auth-secret-at-least-32-characters";
  const auth = createAuth(prisma as never, {
    ...hooks,
    secret,
    baseURL,
    webOrigin,
    get signupsEnabled() {
      return String(policy.signupsEnabled);
    },
    get signupAllowlist() {
      return policy.signupAllowlist;
    },
    email: delivery
      ? {
          describe: () => ({
            id: "offline-email",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { transactional: true },
          }),
          send: (message) => {
            messages.push(message);
            return stalledDelivery ? new Promise<void>(() => undefined) : Promise.resolve();
          },
        }
      : undefined,
  });
  const request = (path: string, body?: unknown, token?: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin ?? webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const signup = (email = "approved@example.test") =>
    request("/sign-up/email", {
      email,
      password: "offline-password12",
      name: "Test User",
      emailVerified: true,
      id: "msg-attacker-chosen-id",
    });
  const signin = (email = "approved@example.test") =>
    request("/sign-in/email", {
      email,
      password: "offline-password12",
    });
  const verify = () => {
    const url = new URL(messages.at(-1)!.text.match(/http:\/\/\S+/)![0]);
    return request(`${url.pathname.replace("/api/auth", "")}${url.search}`);
  };
  const sendCode = (email = "approved@example.test", type = "sign-in") =>
    request("/email-otp/send-verification-otp", { email, type });
  const lastCode = () => messages.at(-1)!.text.match(/\b\d{6}\b/)![0];
  const codeSignIn = (otp: string, email = "approved@example.test") =>
    request("/sign-in/email-otp", { email, otp, name: "Code User" });
  /** An unverified account and session created before email delivery was configured. */
  const legacyAccount = async (email = "approved@example.test") => {
    const now = new Date();
    const id = `legacy-${data.user!.length}`;
    data.user!.push({
      id,
      name: "Legacy",
      email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    data.account!.push({
      id: `account-${id}`,
      userId: id,
      providerId: "credential",
      accountId: id,
      password: await (await auth.$context).password.hash("offline-password12"),
      createdAt: now,
      updatedAt: now,
    });
    const token = `legacy-session-token-${id}`;
    data.session!.push({
      id: `session-${id}`,
      token,
      userId: id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      createdAt: now,
      updatedAt: now,
    });
    members.add(id);
    // Clients hold the signed form the session cookie and `set-auth-token` carry.
    const signature = createHmac("sha256", secret).update(token).digest("base64");
    return { id, token: `${token}.${signature}` };
  };
  const sessionFor = (token: string) =>
    auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  return {
    auth,
    request,
    signup,
    signin,
    verify,
    sendCode,
    lastCode,
    codeSignIn,
    legacyAccount,
    sessionFor,
    prisma,
    data,
    policy,
    messages,
    members,
  };
}

beforeEach(() => vi.clearAllMocks());

it("stores validated signup attribution once, hides it from auth responses, and captures it", async () => {
  const analytics = { capture: vi.fn(), flush: vi.fn(async () => undefined) };
  const f = fixture({ analytics });
  const attribution = { surface: "web", utmSource: "community", utmCampaign: "launch" };
  const response = await f.auth.handler(
    new Request("http://auth.example.test/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://web.example.test",
        cookie: `rakazo_signup_attribution=${encodeURIComponent(JSON.stringify(attribution))}`,
        "x-rakazo-signup-surface": "android",
      },
      body: JSON.stringify({
        email: "new@example.test",
        password: "offline-password12",
        name: "New User",
      }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(f.data.user![0]).toMatchObject({
    signupSurface: "android",
    signupUtmSource: "community",
    signupUtmCampaign: "launch",
  });
  const body = await response.json();
  expect(body).toHaveProperty("user.id");
  expect(body).not.toHaveProperty("user.signupSurface");
  expect(body).not.toHaveProperty("user.signupUtmSource");
  expect(analytics.capture).toHaveBeenCalledWith(
    expect.any(String),
    {
      name: "account_created",
      ...attribution,
      surface: "android",
    },
    { id: expect.any(String), at: expect.any(Date) },
  );
  await f.signin("new@example.test");
  expect(f.data.user![0]).toMatchObject({
    signupSurface: "android",
    signupUtmSource: "community",
    signupUtmCampaign: "launch",
  });
});

describe("client address and security events", () => {
  const signInWith = (f: ReturnType<typeof fixture>, headers: Record<string, string>) =>
    f.auth.handler(
      new Request("http://auth.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://web.example.test",
          ...headers,
        },
        body: JSON.stringify({ email: "approved@example.test", password: "offline-password12" }),
      }),
    );
  const events = () => vi.mocked(recordSecurityEvent).mock.calls.map(([event]) => event);

  it("records the address the API resolved, never a client-supplied forwarding header", async () => {
    const f = fixture({ delivery: false });
    expect((await f.signup()).status).toBe(200);
    vi.mocked(recordSecurityEvent).mockClear();

    const resolved = await signInWith(f, {
      "x-forwarded-for": "198.51.100.66",
      [CLIENT_IP_HEADER]: "203.0.113.5",
    });
    expect(resolved.status).toBe(200);
    expect(f.data.session!.at(-1)!.ipAddress).toBe("203.0.113.5");
    expect(events()).toContainEqual(
      expect.objectContaining({ type: "auth.sign_in", ip: "203.0.113.5" }),
    );

    const spoofed = await signInWith(f, { "x-forwarded-for": "198.51.100.66" });
    expect(spoofed.status).toBe(200);
    expect(f.data.session!.at(-1)!.ipAddress).not.toBe("198.51.100.66");
    expect(JSON.stringify(events())).not.toContain("198.51.100.66");
  });

  it("records sign-up, sign-in, and sign-out without credentials", async () => {
    const f = fixture({ delivery: false });
    const signedUp = await f.signup();
    const { token } = (await signedUp.json()) as { token: string };
    // Revoking a token that is not a live session deletes nothing, so it records nothing.
    expect((await f.request("/revoke-session", { token: "not-a-session" }, token)).status).toBe(
      200,
    );
    expect(events().map((event) => event.type)).not.toContain("auth.session.revoked");
    expect((await f.request("/sign-out", {}, token)).status).toBe(200);

    const types = events().map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(["auth.sign_up", "auth.sign_in", "auth.sign_out"]),
    );
    const serialized = JSON.stringify(events());
    expect(serialized).not.toContain("offline-password12");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("approved@example.test");
  });
});

describe("loopback trusted origins", () => {
  it("accepts Origin localhost when webOrigin is 127.0.0.1", async () => {
    const f = fixture({
      delivery: false,
      baseURL: "http://127.0.0.1:5173",
      webOrigin: "http://127.0.0.1:5173",
      requestOrigin: "http://localhost:5173",
    });
    expect((await f.signup()).status).toBe(200);
  });

  it("accepts Origin 127.0.0.1 when webOrigin is localhost", async () => {
    const f = fixture({
      delivery: false,
      baseURL: "http://localhost:5173",
      webOrigin: "http://localhost:5173",
      requestOrigin: "http://127.0.0.1:5173",
    });
    expect((await f.signup()).status).toBe(200);
  });
});

describe("identity trust through auth endpoints", () => {
  // These branches sit behind Better Auth's HTTP checks, so call the session hook directly.
  it.each([
    ["missing user", null],
    ["messaging identity", "msg-test@messaging.invalid"],
    ["email delivery", "approved@example.test"],
    ["disallowed email", "outsider@other.test", false],
    ["first-account claim denied", "approved@example.test", false],
  ])("codes required verification for %s", async (reason, email, delivery = true) => {
    const f = fixture({ allowlist: "@example.test", delivery });
    if (reason === "first-account claim denied") {
      f.data.user!.push({ id: "other-user", email: "other@example.test" });
    }
    const hook = f.auth.options.databaseHooks!.session!.create!.before!;
    await expect(
      hook(
        { userId: "pending-user" } as never,
        {
          path: "/sign-in/email",
          context: {
            internalAdapter: {
              findUserById: vi.fn(async () =>
                email ? { id: "pending-user", email, emailVerified: false } : null,
              ),
            },
          },
        } as never,
      ),
    ).rejects.toMatchObject({
      body: { code: "EMAIL_VERIFICATION_REQUIRED", message: "Email verification required" },
    });
  });

  it("returns a translation code when registration is closed", async () => {
    const f = fixture();
    f.policy.signupsEnabled = false;
    const response = await f.signup();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "REGISTRATION_CLOSED",
      message: "Registration is closed",
    });
  });

  it("permits ordinary unverified signup without granting admin or mailbox proof on open deployments", async () => {
    const f = fixture({ delivery: false });
    const response = await f.signup();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      user: { id: string; emailVerified: boolean };
    };
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.emailVerified).toBe(false);
    expect(body.user.id).not.toBe("msg-attacker-chosen-id");
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect((await f.signin()).status).toBe(200);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("never lets a first allowlisted account skip mailbox proof without delivery", async () => {
    const f = fixture({ allowlist: "@example.test", delivery: false });
    const results = await Promise.all([f.signup(), f.signup("second@example.test")]);
    for (const response of results) {
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Registration requires email delivery");
    }
    expect(f.data.user).toHaveLength(0);
    expect(f.policy.ownerUserId).toBeNull();
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("keeps allowlisted signup closed without delivery once a human account exists", async () => {
    const f = fixture({ allowlist: "@example.test", delivery: false });
    f.data.user!.push({
      id: "human-1",
      name: "Owner",
      email: "owner@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await f.signup("second@example.test");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Registration requires email delivery");
    expect(f.data.user).toHaveLength(1);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("requires mailbox proof before creating a session, space or first-owner claim", async () => {
    const f = fixture({ allowlist: "approved@example.test" });
    expect((await f.signup("outsider@example.test")).status).toBe(400);
    const response = await f.signup();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ token: null, user: { emailVerified: false } });
    expect(f.data.session).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    expect((await f.signin()).status).toBe(403);
    expect(f.messages).toHaveLength(2);
    expect((await f.request("/verify-email?token=forged-token")).status).not.toBe(200);
    expect(f.data.user![0]!.emailVerified).toBe(false);
    const verified = await f.verify();
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("http://web.example.test/sign-in");
    expect(verified.headers.get("set-cookie")).toBeNull();
    expect(f.data.user![0]!.emailVerified).toBe(true);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    const signedIn = await f.signin();
    expect(signedIn.status).toBe(200);
    const { token } = (await signedIn.json()) as { token: string };
    expect(token).toEqual(expect.any(String));
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect(
      await f.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
    ).toMatchObject({ user: { emailVerified: true } });
  });

  it("rechecks policy before admitting a verified but unprovisioned signup", async () => {
    const f = fixture({ allowlist: "@example.test" });
    await f.signup();
    await f.verify();
    f.policy.signupsEnabled = false;
    const response = await f.signin();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "REGISTRATION_CLOSED",
      message: "Registration is closed",
    });
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    f.policy.signupsEnabled = true;
    f.policy.signupAllowlist = "someone-else@example.test";
    expect((await f.signin()).status).toBe(403);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("gates existing unverified sessions and auth mutations when the live allowlist is enabled", async () => {
    const f = fixture();
    const { token } = await f.legacyAccount();
    expect(await f.sessionFor(token)).not.toBeNull();
    f.policy.signupAllowlist = "@example.test";
    expect(await (await f.request("/get-session", undefined, token)).json()).toBeNull();
    expect(
      await f.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
    ).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, token)).status).toBe(401);
    expect((await f.signin()).status).toBe(403);
    await f.verify();
    expect((await f.signin()).status).toBe(200);
  });

  it("does not leak request-local verification settings when signup policy changes", async () => {
    const f = fixture({ delivery: false });
    expect(await (await f.signup()).json()).toMatchObject({ token: expect.any(String) });
    f.policy.signupAllowlist = "@example.test";
    expect((await f.signin()).status).toBe(403);
    f.policy.signupAllowlist = "";
    expect((await f.signin()).status).toBe(200);
    f.policy.signupAllowlist = "@example.test";
    expect((await f.signin()).status).toBe(403);
  });

  it("reserves internal messaging emails across registration, recovery and email changes", async () => {
    const f = fixture();
    for (const email of [
      "msg-sendblue15550001111@messaging.invalid",
      "MSG-Test@MESSAGING.INVALID",
    ]) {
      expect((await f.signup(email)).status).toBe(400);
      expect((await f.signin(email)).status).toBe(400);
      expect((await f.request("/request-password-reset", { email })).status).toBe(400);
      expect((await f.request("/send-verification-email", { email })).status).toBe(400);
      expect((await f.sendCode(email)).status).toBe(400);
      expect((await f.codeSignIn("123456", email)).status).toBe(400);
    }
    expect(f.data.user).toHaveLength(0);
    const { token } = await f.legacyAccount();
    expect(
      (await f.request("/change-email", { newEmail: "msg-taken@messaging.invalid" }, token)).status,
    ).toBe(400);
    // An account preclaimed before this upgrade must not keep its session.
    f.data.user![0]!.email = "msg-taken@messaging.invalid";
    expect(await (await f.request("/get-session", undefined, token)).json()).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, token)).status).toBe(401);
    expect(f.messages).toHaveLength(0);
  });
});

describe("session credentials", () => {
  it("lists and reads sessions without handing out their tokens", async () => {
    const f = fixture({ delivery: false });
    await f.signup();
    const tokens: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      tokens.push(((await (await f.signin()).json()) as { token: string }).token);
    }
    const listed = await f.request("/list-sessions", undefined, tokens[0]);
    expect(listed.status).toBe(200);
    const text = await listed.text();
    const sessions = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const session of sessions) {
      expect(session).toMatchObject({ id: expect.any(String), userId: expect.any(String) });
      expect(session).not.toHaveProperty("token");
    }
    for (const token of tokens) expect(text).not.toContain(token);

    const current = await f.request("/get-session", undefined, tokens[0]);
    const body = (await current.json()) as { session: Record<string, unknown>; user: unknown };
    expect(body.user).toMatchObject({ email: "approved@example.test" });
    expect(body.session).not.toHaveProperty("token");
    const server = await f.auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${tokens[1]}` }),
    });
    expect(server?.session).not.toHaveProperty("token");
  });

  it("stores password reset tokens hashed and accepts one stored before hashing", async () => {
    const f = fixture();
    const { user } = (await (await f.signup()).json()) as { user: { id: string } };
    expect(
      (await f.request("/request-password-reset", { email: "approved@example.test" })).status,
    ).toBe(200);
    const token = f.messages.at(-1)!.text.match(/reset-password\/([^?\s]+)/)![1]!;
    expect(f.data.verification!.some((row) => String(row.identifier).includes(token))).toBe(false);
    const reset = await f.request("/reset-password", { token, newPassword: "offline-password34" });
    expect(reset.status, await reset.clone().text()).toBe(200);
    f.data.verification!.push({
      id: "legacy-reset",
      identifier: "reset-password:legacy-reset-token",
      value: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const legacy = await f.request("/reset-password", {
      token: "legacy-reset-token",
      newPassword: "offline-password56",
    });
    expect(legacy.status, await legacy.clone().text()).toBe(200);
    const signedIn = await f.request("/sign-in/email", {
      email: "approved@example.test",
      password: "offline-password56",
    });
    expect(signedIn.status).toBe(200);
  });

  it("requires the password to delete an account, even from a fresh session", async () => {
    const f = fixture({ delivery: false });
    const { token } = (await (await f.signup()).json()) as { token: string };
    for (const body of [{}, { password: "" }, { password: "wrong-password12" }]) {
      const response = await f.request("/delete-user", body, token);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(f.data.user).toHaveLength(1);
    }
    const deleted = await f.request("/delete-user", { password: "offline-password12" }, token);
    expect(deleted.status).toBe(200);
    expect(f.data.user).toHaveLength(0);
  });

  it("answers a deletion already under way with a conflict and keeps the account", async () => {
    const f = fixture({
      delivery: false,
      beforeDeleteUser: async () => {
        throw new SpaceDeletionInProgressError();
      },
    });
    const { token } = (await (await f.signup()).json()) as { token: string };
    const response = await f.request("/delete-user", { password: "offline-password12" }, token);
    expect(response.status).toBe(409);
    expect(f.data.user).toHaveLength(1);
  });
});

describe("identity confirmation", () => {
  afterEach(() => vi.useRealTimers());
  const confirmed = async (f: ReturnType<typeof fixture>, token: string) => {
    const current = await f.sessionFor(token);
    return f.auth.hasRecentIdentityConfirmation({
      sessionId: current!.session.id,
      userId: current!.user.id,
    });
  };
  const codeAccount = async (f: ReturnType<typeof fixture>) => {
    await f.sendCode();
    return ((await (await f.codeSignIn(f.lastCode())).json()) as { token: string }).token;
  };
  const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

  it("confirms a password session for five minutes, and only that session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture({ delivery: false });
    const { token } = (await (await f.signup()).json()) as { token: string };
    const other = ((await (await f.signin()).json()) as { token: string }).token;
    expect(await confirmed(f, token)).toBe(false);
    for (const body of [{}, { password: "" }, { password: "wrong-password12" }]) {
      const response = await f.request("/confirm-identity", body, token);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_PASSWORD" });
    }
    expect(await confirmed(f, token)).toBe(false);
    expect(
      (await f.request("/confirm-identity", { password: "offline-password12" }, token)).status,
    ).toBe(200);
    expect(await confirmed(f, token)).toBe(true);
    expect(await confirmed(f, other)).toBe(false);
    expect(recordSecurityEvent).toHaveBeenCalledWith({
      type: "auth.identity.confirmed",
      userId: f.data.user![0]!.id,
      metadata: { method: "password" },
    });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await confirmed(f, token)).toBe(false);
  });

  it("refuses a session that is not signed in", async () => {
    const f = fixture({ delivery: false });
    expect((await f.request("/confirm-identity", { password: "offline-password12" })).status).toBe(
      401,
    );
  });

  it("locks password confirmation after five wrong passwords", async () => {
    const f = fixture({ delivery: false });
    const { token } = (await (await f.signup()).json()) as { token: string };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = { password: "wrong-password12" };
      expect((await f.request("/confirm-identity", wrong, token)).status).toBe(400);
    }
    const locked = await f.request("/confirm-identity", { password: "offline-password12" }, token);
    expect(locked.status).toBe(429);
    expect(await confirmed(f, token)).toBe(false);
  });

  it("counts every parallel password guess toward the limit", async () => {
    const f = fixture({ delivery: false });
    const { token } = (await (await f.signup()).json()) as { token: string };
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () =>
        f
          .request("/confirm-identity", { password: "wrong-password12" }, token)
          .then((response) => response.status),
      ),
    );
    expect(statuses.filter((status) => status === 400)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
    const locked = await f.request("/confirm-identity", { password: "offline-password12" }, token);
    expect(locked.status).toBe(429);
  });

  it("frees password attempts once the lockout window passes, and clears them on success", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture({ delivery: false });
    const { token } = (await (await f.signup()).json()) as { token: string };
    const attempt = (password: string) =>
      f.request("/confirm-identity", { password }, token).then((response) => response.status);
    for (let index = 0; index < 5; index += 1) await attempt("wrong-password12");
    expect(await attempt("offline-password12")).toBe(429);
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    for (let index = 0; index < 4; index += 1) await attempt("wrong-password12");
    expect(await attempt("offline-password12")).toBe(200);
    expect(await attempt("wrong-password12")).toBe(400);
    expect(await attempt("offline-password12")).toBe(200);
  });

  it("confirms an account without a password by a single-use emailed code", async () => {
    const f = fixture();
    const token = await codeAccount(f);
    expect((await f.request("/request-identity-code", {}, token)).status).toBe(200);
    expect(f.messages.at(-1)).toMatchObject({
      to: "approved@example.test",
      subject: "Your Rakazo confirmation code",
    });
    const code = f.lastCode();
    expect(JSON.stringify(f.data.verification)).not.toContain(code);
    const wrong = await f.request("/confirm-identity", { code: wrongCode(code) }, token);
    expect(await wrong.json()).toMatchObject({ code: "INVALID_OTP" });
    expect(await confirmed(f, token)).toBe(false);
    expect((await f.request("/confirm-identity", { code }, token)).status).toBe(200);
    expect(await confirmed(f, token)).toBe(true);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "auth.identity.confirmed", metadata: { method: "email" } }),
    );
    const reused = await f.request("/confirm-identity", { code }, token);
    expect(await reused.json()).toMatchObject({ code: "OTP_EXPIRED" });
  });

  it("writes a code email in the language the account last used the app in", async () => {
    const f = fixture();
    const token = await codeAccount(f);
    const user = f.data.user!.find((row) => row.email === "approved@example.test")!;
    user.locale = "es";
    expect((await f.request("/request-identity-code", {}, token)).status).toBe(200);
    expect(f.messages.at(-1)).toMatchObject({ subject: "Tu código de confirmación de Rakazo" });
  });

  it("binds an emailed code to the session that requested it", async () => {
    const f = fixture();
    const token = await codeAccount(f);
    await f.sendCode();
    const other = ((await (await f.codeSignIn(f.lastCode())).json()) as { token: string }).token;
    await f.request("/request-identity-code", {}, token);
    const code = f.lastCode();
    expect((await f.request("/confirm-identity", { code }, other)).status).toBe(400);
    expect((await f.request("/confirm-identity", { code }, token)).status).toBe(200);
    expect(await confirmed(f, other)).toBe(false);
  });

  it("locks an emailed code after three wrong attempts", async () => {
    const f = fixture();
    const token = await codeAccount(f);
    await f.request("/request-identity-code", {}, token);
    const code = f.lastCode();
    for (const expected of ["INVALID_OTP", "INVALID_OTP", "TOO_MANY_ATTEMPTS"]) {
      const response = await f.request("/confirm-identity", { code: wrongCode(code) }, token);
      expect(await response.json()).toMatchObject({ code: expected });
    }
    expect((await f.request("/confirm-identity", { code }, token)).status).toBe(400);
    expect(await confirmed(f, token)).toBe(false);
  });

  it("keeps password accounts on their password", async () => {
    const f = fixture();
    const { token } = (await (await f.signup()).json()) as { token: string };
    const requested = await f.request("/request-identity-code", {}, token);
    expect(await requested.json()).toMatchObject({ code: "EMAIL_CODE_UNAVAILABLE" });
    expect((await f.request("/confirm-identity", { code: "123456" }, token)).status).toBe(400);
    expect(await confirmed(f, token)).toBe(false);
  });
});

describe("verification email without blocking", () => {
  it("signs an open password signup in at once and lets the emailed link mark it verified", async () => {
    const f = fixture();
    const response = await f.signup();
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(await f.sessionFor(token)).toMatchObject({ user: { emailVerified: false } });
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatchObject({ subject: "Verify your Rakazo email" });
    expect((await f.signin()).status).toBe(200);
    expect(f.messages).toHaveLength(1);
    await f.verify();
    expect(await f.sessionFor(token)).toMatchObject({ user: { emailVerified: true } });
  });

  it("keeps existing unverified accounts signing in with a password", async () => {
    const f = fixture();
    const { token } = await f.legacyAccount();
    expect(await f.sessionFor(token)).toMatchObject({ user: { emailVerified: false } });
    expect((await f.signin()).status).toBe(200);
    expect(await f.sessionFor(token)).not.toBeNull();
    expect(f.messages).toHaveLength(0);
  });
});

describe("email code sign-in", () => {
  it("creates a verified account and session from a single-use code", async () => {
    const f = fixture();
    expect((await f.sendCode()).status).toBe(200);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatchObject({
      to: "approved@example.test",
      subject: "Your Rakazo sign-in code",
    });
    const code = f.lastCode();
    expect(JSON.stringify(f.data.verification)).not.toContain(code);
    const wrong = await f.codeSignIn(code === "000000" ? "111111" : "000000");
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "INVALID_OTP" });
    const response = await f.codeSignIn(code);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; user: { emailVerified: boolean } };
    expect(body.user.emailVerified).toBe(true);
    expect(await f.sessionFor(body.token)).toMatchObject({ user: { emailVerified: true } });
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect((await f.codeSignIn(code)).status).toBe(400);
  });

  it("answers a code request without waiting for delivery", async () => {
    const f = fixture({ stalledDelivery: true });
    const timeout = new Promise<"timed out">((resolve) => setTimeout(resolve, 2_000, "timed out"));
    const response = await Promise.race([f.sendCode(), timeout]);
    expect(response).not.toBe("timed out");
    expect((response as Response).status).toBe(200);
    expect(f.messages).toHaveLength(1);
    expect((await f.codeSignIn(f.lastCode())).status).toBe(200);
  });

  it("locks a code after three wrong attempts", async () => {
    const f = fixture();
    await f.sendCode();
    const code = f.lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await f.codeSignIn(wrong)).status).toBe(400);
    }
    expect((await f.codeSignIn(code)).status).toBeGreaterThanOrEqual(400);
    expect(f.data.user).toHaveLength(0);
  });

  it("applies the signup policy before a code can create an account", async () => {
    const f = fixture({ allowlist: "@example.test" });
    expect((await f.sendCode("outsider@other.test")).status).toBe(200);
    expect(f.messages).toHaveLength(0);
    expect(f.data.verification).toHaveLength(0);
    const refused = await f.codeSignIn("123456", "outsider@other.test");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "INVALID_OTP" });

    await f.sendCode();
    const code = f.lastCode();
    f.policy.signupsEnabled = false;
    expect((await f.codeSignIn(code)).status).toBe(400);
    expect(f.data.user).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("still signs existing accounts in when registration is closed", async () => {
    const f = fixture();
    f.data.user!.push({
      id: "member-1",
      name: "Member",
      email: "approved@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    f.members.add("member-1");
    f.policy.signupsEnabled = false;
    await f.sendCode();
    expect(f.messages).toHaveLength(1);
    const response = await f.codeSignIn(f.lastCode());
    expect(response.status).toBe(200);
    expect(f.data.user).toHaveLength(1);
  });

  it("drops access an unverified account gained before its mailbox owner signed in", async () => {
    const f = fixture();
    // Someone registers the owner's address with their own password and keeps a session.
    const squatter = await f.signup();
    const { token } = (await squatter.json()) as { token: string };
    const userId = f.data.user![0]!.id as string;
    expect(await f.sessionFor(token)).not.toBeNull();
    f.data.account!.push({
      id: "oidc-link",
      userId,
      providerId: "oidc",
      accountId: "squatter-subject",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await f.sendCode();
    const owner = await f.codeSignIn(f.lastCode());
    expect(owner.status).toBe(200);
    const { token: ownerToken } = (await owner.json()) as { token: string };
    expect(f.data.user).toHaveLength(1);
    expect(f.data.user![0]).toMatchObject({ id: userId, emailVerified: true });
    expect(await f.sessionFor(token)).toBeNull();
    expect(f.data.account!.filter((account) => account.userId === userId)).toHaveLength(0);
    expect((await f.signin()).status).toBe(401);
    expect(await f.sessionFor(ownerToken)).toMatchObject({ user: { id: userId } });
  });

  it("keeps a verified account's password and sessions on code sign-in", async () => {
    const f = fixture();
    const { token } = (await (await f.signup()).json()) as { token: string };
    await f.verify();
    await f.sendCode();
    expect((await f.codeSignIn(f.lastCode())).status).toBe(200);
    expect(await f.sessionFor(token)).not.toBeNull();
    expect((await f.signin()).status).toBe(200);
  });

  it("closes the OTP routes Rakazo does not use", async () => {
    const f = fixture();
    for (const type of ["email-verification", "forget-password", "change-email"]) {
      expect((await f.sendCode("approved@example.test", type)).status, type).toBe(404);
    }
    for (const path of [
      "/email-otp/check-verification-otp",
      "/email-otp/verify-email",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
      "/email-otp/request-email-change",
      "/email-otp/change-email",
    ]) {
      const response = await f.request(path, {
        email: "approved@example.test",
        newEmail: "new@example.test",
        type: "sign-in",
        otp: "123456",
        password: "offline-password12",
      });
      expect(response.status, path).toBe(404);
    }
    expect(f.messages).toHaveLength(0);
  });

  it("is unavailable without email delivery", async () => {
    const f = fixture({ delivery: false });
    expect(f.auth.emailCodeSignIn).toBe(false);
    expect((await f.sendCode()).status).toBe(404);
    expect((await f.codeSignIn("123456")).status).toBe(404);
    expect(fixture().auth.emailCodeSignIn).toBe(true);
  });
});
describe("passkeys", () => {
  const webOrigin = "https://web.example.test";
  const passkeyFixture = (options: Parameters<typeof fixture>[0] = {}) => {
    const f = fixture({ baseURL: "https://auth.example.test", webOrigin, ...options });
    const call = async (
      path: string,
      { body, token, cookie }: { body?: unknown; token?: string; cookie?: string } = {},
    ) =>
      f.auth.handler(
        new Request(`https://auth.example.test/api/auth${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            "content-type": "application/json",
            origin: webOrigin,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(cookie ? { cookie } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
    const authenticator = softwareAuthenticator("web.example.test", webOrigin);
    const register = async (token: string) => {
      const options = await call("/passkey/generate-register-options", { token });
      if (options.status !== 200) return options;
      const { challenge } = (await options.json()) as { challenge: string };
      return call("/passkey/verify-registration", {
        token,
        cookie: challengeCookie(options),
        body: { response: authenticator.create(challenge) },
      });
    };
    const signInWithPasskey = async () => {
      const options = await call("/passkey/generate-authenticate-options");
      const { challenge } = (await options.json()) as { challenge: string };
      return call("/passkey/verify-authentication", {
        cookie: challengeCookie(options),
        body: { response: authenticator.get(challenge) },
      });
    };
    return { ...f, call, register, signInWithPasskey };
  };

  it("registers from a signed-in session and signs in through the session hooks", async () => {
    const f = passkeyFixture({ delivery: false });
    const { token } = (await (await f.signup()).json()) as { token: string };
    const registered = await f.register(token);
    expect(registered.status).toBe(200);
    expect(f.data.passkey).toHaveLength(1);
    const listed = await f.call("/passkey/list-user-passkeys", { token });
    expect(await listed.json()).toEqual([expect.objectContaining({ userId: f.data.user![0]!.id })]);

    const signedIn = await f.signInWithPasskey();
    expect(signedIn.status).toBe(200);
    const body = (await signedIn.json()) as { session: { token: string }; user: { id: string } };
    expect(body.user.id).toBe(f.data.user![0]!.id);
    expect(
      await f.auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${body.session.token}` }),
      }),
    ).toMatchObject({ user: { id: body.user.id } });
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("registers only from a fresh session of the account", async () => {
    const f = passkeyFixture({ delivery: false });
    expect((await f.call("/passkey/generate-register-options")).status).toBe(401);
    const { token } = (await (await f.signup()).json()) as { token: string };
    for (const session of f.data.session!) {
      session.createdAt = new Date(Date.now() - 2 * 86_400_000);
    }
    const stale = await f.register(token);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: "SESSION_NOT_FRESH" });
    expect(f.data.passkey).toHaveLength(0);
  });

  it("applies the sign-in gates to passkey sessions", async () => {
    const f = passkeyFixture();
    const { token } = (await (await f.signup()).json()) as { token: string };
    expect((await f.register(token)).status).toBe(200);
    const sessions = f.data.session!.length;

    // An unverified email under a live allowlist, exactly like password sign-in.
    f.policy.signupAllowlist = "@example.test";
    const unverified = await f.signInWithPasskey();
    expect(unverified.status).toBe(403);
    expect(await unverified.json()).toMatchObject({ code: "EMAIL_VERIFICATION_REQUIRED" });
    expect(f.data.session).toHaveLength(sessions);

    f.policy.signupAllowlist = "";
    f.data.user![0]!.email = "msg-taken@messaging.invalid";
    expect((await f.signInWithPasskey()).status).toBe(403);
    expect(f.data.session).toHaveLength(sessions);
  });

  it("deletes passkeys with the account", async () => {
    const f = passkeyFixture({ delivery: false });
    const { token } = (await (await f.signup()).json()) as { token: string };
    expect((await f.register(token)).status).toBe(200);
    const deleted = await f.call("/delete-user", {
      token,
      body: { password: "offline-password12" },
    });
    expect(deleted.status).toBe(200);
    expect(f.data.passkey).toHaveLength(0);
    expect((await f.signInWithPasskey()).status).toBe(401);
  });

  it("drops credentials an unverified account added before its mailbox owner signed in", async () => {
    const f = passkeyFixture();
    const { token } = (await (await f.signup()).json()) as { token: string };
    expect((await f.register(token)).status).toBe(200);
    const userId = f.data.user![0]!.id;
    await f.sendCode();
    expect((await f.codeSignIn(f.lastCode())).status).toBe(200);
    expect(f.data.user![0]).toMatchObject({ id: userId, emailVerified: true });
    expect(f.data.passkey).toHaveLength(0);
    expect((await f.signInWithPasskey()).status).toBe(401);
    expect(f.prisma.messagingIdentity.deleteMany).toHaveBeenCalledWith({ where: { userId } });
    expect(f.prisma.messagingLinkCode.deleteMany).toHaveBeenCalledWith({ where: { userId } });
    expect(f.prisma.userDevice.updateMany).toHaveBeenCalledWith({
      where: { userId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(f.prisma.$transaction).not.toHaveBeenCalledWith(expect.any(Array));
  });

  it("keeps a verified account's passkeys on code sign-in", async () => {
    const f = passkeyFixture();
    const { token } = (await (await f.signup()).json()) as { token: string };
    expect((await f.register(token)).status).toBe(200);
    f.data.user![0]!.emailVerified = true;
    await f.sendCode();
    expect((await f.codeSignIn(f.lastCode())).status).toBe(200);
    expect(f.data.passkey).toHaveLength(1);
    expect(f.prisma.userDevice.updateMany).not.toHaveBeenCalled();
    expect((await f.signInWithPasskey()).status).toBe(200);
  });

  it("does not offer passkeys where a browser cannot create them", async () => {
    const f = fixture({ webOrigin: "http://web.example.test" });
    expect(f.auth.passkeyRpId).toBeNull();
    expect((await f.request("/passkey/generate-authenticate-options")).status).toBe(404);
  });
});

describe("account export tokens", () => {
  afterEach(() => vi.useRealTimers());

  it("names the issuing user once, and stores only a hash", async () => {
    const f = fixture({ delivery: false });
    const token = await f.auth.issueAccountExportToken("user-a");
    const other = await f.auth.issueAccountExportToken("user-b");
    expect(JSON.stringify(f.data.verification)).not.toContain(token);
    expect(await f.auth.consumeAccountExportToken(token)).toBe("user-a");
    expect(await f.auth.consumeAccountExportToken(token)).toBeNull();
    expect(await f.auth.consumeAccountExportToken(other)).toBe("user-b");
    expect(await f.auth.consumeAccountExportToken("")).toBeNull();
    expect(await f.auth.consumeAccountExportToken("made-up")).toBeNull();
  });

  it("expires after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture({ delivery: false });
    const token = await f.auth.issueAccountExportToken("user-a");
    vi.setSystemTime(Date.now() + 60_000);
    expect(await f.auth.consumeAccountExportToken(token)).toBeNull();
  });
});

function challengeCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(/(?:__Secure-)?better-auth\.better-auth-passkey=[^;]+/);
  if (!match) throw new Error("missing passkey challenge cookie");
  return match[0];
}

/** Minimal offline platform authenticator: "none" attestation, ES256, one credential. */
function softwareAuthenticator(rpId: string, origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  const id = credentialId.toString("base64url");
  const rpIdHash = createHash("sha256").update(rpId).digest();
  let counter = 0;
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const counterBytes = () => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(counter);
    return bytes;
  };
  return {
    create(challenge: string) {
      const coseKey = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, "base64url")],
          [-3, Buffer.from(jwk.y!, "base64url")],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([0x45]),
        counterBytes(),
        Buffer.alloc(16),
        length,
        credentialId,
        coseKey,
      ]);
      const attestationObject = cbor(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: clientData("webauthn.create", challenge).toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    get(challenge: string) {
      counter += 1;
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counterBytes()]);
      const data = clientData("webauthn.get", challenge);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(data).digest()]),
        privateKey,
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: data.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
}

/** CBOR for the handful of types WebAuthn attestation needs. */
function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(length, 1);
    return bytes;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
    ]);
  }
  throw new Error("unsupported CBOR value");
}

describe("single-person deployments", () => {
  const password = "offline-password12";

  it("admits the first account, then closes registration to anyone else", async () => {
    const f = fixture({ delivery: false, singleAccount: true });
    expect((await f.signup("owner@example.test")).status).toBe(200);

    const second = await f.signup("someone@example.test");
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(f.data.user!.map((user) => user.email)).toEqual(["owner@example.test"]);

    expect((await f.signin("owner@example.test")).status).toBe(200);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("refuses a session to an account that was never admitted", async () => {
    const f = fixture({ delivery: false, singleAccount: true });
    expect((await f.signup("owner@example.test")).status).toBe(200);
    const now = new Date();
    f.data.user!.push({
      id: "late-user",
      name: "Late",
      email: "late@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    f.data.account!.push({
      id: "account-late-user",
      userId: "late-user",
      providerId: "credential",
      accountId: "late-user",
      password: await (await f.auth.$context).password.hash(password),
      createdAt: now,
      updatedAt: now,
    });
    const response = await f.signin("late@example.test");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(f.members.has("late-user")).toBe(false);
  });

  it("does not create an account from an emailed code once there is one", async () => {
    const f = fixture({ singleAccount: true });
    expect((await f.signup("owner@example.test")).status).toBe(200);
    const sent = f.messages.length;
    expect((await f.sendCode("someone@example.test")).status).toBe(200);
    expect(f.messages).toHaveLength(sent);
  });

  it("ignores messaging-only users when admitting the first account", async () => {
    const f = fixture({ delivery: false, singleAccount: true });
    const now = new Date();
    f.data.user!.push({
      id: "msg-user",
      name: "Chat",
      email: "msg-abc@messaging.invalid",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    expect((await f.signup("owner@example.test")).status).toBe(200);
  });

  it("is not closed by an earlier signup that never got in", async () => {
    const f = fixture({ delivery: false, singleAccount: true });
    const now = new Date();
    f.data.user!.push({
      id: "abandoned",
      name: "Abandoned",
      email: "abandoned@example.test",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    expect((await f.signup("owner@example.test")).status).toBe(200);
    expect((await f.signup("someone@example.test")).status).toBe(400);
  });

  it("keeps registration open on other deployments", async () => {
    const f = fixture({ delivery: false });
    expect((await f.signup("owner@example.test")).status).toBe(200);
    expect((await f.signup("someone@example.test")).status).toBe(200);
  });
});

describe("ending sessions", () => {
  const sessionIds = (rows: Record<string, unknown>[]) => rows.map((row) => String(row.id));

  async function signedInTwice() {
    const afterDeleteSession = vi.fn(async (_session: { id: string; userId: string }) => {});
    const afterReplaceSession = vi.fn(
      async (
        _previous: { id: string; userId: string },
        _next: { id: string; userId: string },
      ) => {},
    );
    const f = fixture({ afterDeleteSession, afterReplaceSession });
    const { token: first } = (await (await f.signup()).json()) as { token: string };
    const { token: second } = (await (await f.signin()).json()) as { token: string };
    const ids = sessionIds(f.data.session!);
    expect(ids).toHaveLength(2);
    return { f, first, second, ids, afterDeleteSession, afterReplaceSession };
  }
  const ended = (hook: { mock: { calls: [{ id: string }, ...unknown[]][] } }) =>
    hook.mock.calls.map(([session]) => session.id).sort();

  it("reports every session a password reset ends", async () => {
    const { f, ids, afterDeleteSession } = await signedInTwice();
    await f.request("/request-password-reset", { email: "approved@example.test" });
    const token = f.messages.at(-1)!.text.match(/reset-password\/([^?\s]+)/)![1]!;
    const reset = await f.request("/reset-password", { token, newPassword: "offline-password34" });
    expect(reset.status).toBe(200);
    expect(f.data.session).toHaveLength(0);
    expect(ended(afterDeleteSession)).toEqual([...ids].sort());
  });

  it("reports every session that signing out everywhere ends", async () => {
    const { f, first, ids, afterDeleteSession } = await signedInTwice();
    expect((await f.request("/revoke-sessions", {}, first)).status).toBe(200);
    expect(ended(afterDeleteSession)).toEqual([...ids].sort());
  });

  it("reports the other sessions a password change ends and moves the caller's own", async () => {
    const { f, second, ids, afterDeleteSession, afterReplaceSession } = await signedInTwice();
    const changed = await f.request(
      "/change-password",
      {
        currentPassword: "offline-password12",
        newPassword: "offline-password34",
        revokeOtherSessions: true,
      },
      second,
    );
    expect(changed.status).toBe(200);
    expect(ended(afterDeleteSession)).toEqual([ids[0]]);
    expect(afterReplaceSession).toHaveBeenCalledTimes(1);
    const [previous, next] = afterReplaceSession.mock.calls[0]!;
    expect(previous.id).toBe(ids[1]);
    expect(sessionIds(f.data.session!)).toEqual([next.id]);
  });
});
