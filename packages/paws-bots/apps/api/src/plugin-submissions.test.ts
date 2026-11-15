import { EmailEmulator } from "@rakazo/adapters";
import {
  INTEGRATION_CLAIMS_PATH,
  PLUGIN_SUBMISSIONS_PATH,
  PluginSubmissionSchema,
} from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof import("@rakazo/adapters")>()),
  previewPluginInstall: preview,
}));

const {
  approvedIntegrationClaims,
  approvedPluginEntries,
  listPluginSubmissions,
  pluginSubmissionRoutes,
  reviewPluginSubmission,
} = await import("./plugin-submissions.js");

const SHA = "a".repeat(40);
const valid = {
  email: "dev@example.test",
  name: "Acme Tickets",
  logo: "https://example.test/logo.svg",
  source: "https://github.com/acme/plugins/tree/main/tickets",
  description: "Search Acme tickets.",
  testing: "Ask a bot to find ticket 42.",
  tested: true,
};
const claim = {
  claim: "acme-tickets",
  email: "owner@acme.test",
  name: "Acme Tickets",
  website: "https://www.acme.test",
};

type Row = Record<string, unknown> & {
  id: string;
  status: string;
  source: string | null;
  claim: string | null;
};

type Status = string | { in: string[] };
const statusIs = (status: unknown, want: Status) =>
  typeof want === "string" ? status === want : want.in.includes(status as string);

function fakePrisma(users: Array<{ id: string; email: string; emailVerified: boolean }> = []) {
  const rows: Row[] = [];
  const stamp = (data: Record<string, unknown>): Record<string, unknown> => ({
    reviewedAt: null,
    reason: null,
    ...data,
  });
  const pluginSubmission = {
    findFirst: async ({
      where,
    }: {
      where: { source?: string; claim?: string; email: string; status: Status };
    }) =>
      rows.find(
        (row) =>
          (where.claim ? row.claim === where.claim : row.source === where.source) &&
          row.email === where.email &&
          statusIs(row.status, where.status),
      ) ?? null,
    findUnique: async ({ where }: { where: { id?: string; confirmToken?: string } }) => {
      const row = rows.find((candidate) =>
        where.confirmToken
          ? candidate.confirmToken === where.confirmToken
          : candidate.id === where.id,
      );
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = stamp({
        status: "pending",
        ...data,
        id: `sub-${rows.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(0),
      }) as Row;
      rows.push(row);
      return row;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
      rows.find((row) => row.id === where.id)!,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status: Status; updatedAt?: Date; confirmToken?: string };
      data: Record<string, unknown>;
    }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row || !statusIs(row.status, where.status)) return { count: 0 };
      if (where.confirmToken && where.confirmToken !== row.confirmToken) return { count: 0 };
      if (where.updatedAt && where.updatedAt !== row.updatedAt) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() });
      return { count: 1 };
    },
    findMany: async ({ where }: { where: { status: string; claim?: unknown } }) =>
      rows
        .filter((row) =>
          where.claim ? row.status === where.status && row.claim : row.status === where.status,
        )
        .filter((row) => where.claim || where.status !== "approved" || row.pinnedSource)
        .toSorted((a, b) => Number(b.reviewedAt ?? 0) - Number(a.reviewedAt ?? 0)),
  };
  const user = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      users.find((candidate) => candidate.id === where.id) ?? null,
  };
  return { rows, prisma: { pluginSubmission, user } as never };
}

function routes(prisma: never, email = new EmailEmulator()) {
  const app = pluginSubmissionRoutes({
    prisma,
    email,
    adminEmails: ["admin@example.test"],
    webOrigin: "https://app.example.test",
    clientIp: () => "203.0.113.7",
    onEmailError: (error) => {
      throw error;
    },
  });
  const submit = (body: unknown) =>
    app.request(PLUGIN_SUBMISSIONS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const open = (url: string) => app.request(url.replace("https://app.example.test", ""));
  const claims = async () =>
    (await (await app.request(INTEGRATION_CLAIMS_PATH)).json()) as { claims: unknown[] };
  return { submit, claims, open, email };
}

beforeEach(() => preview.mockReset());

describe("public plugin submissions", () => {
  it("stores the repository, branch and folder and emails the submitter and admins", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit, email } = routes(prisma);
    const response = await submit(valid);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "sub-1", status: "pending" });
    expect(rows[0]).toMatchObject({
      source: "https://github.com/acme/plugins@main#tickets",
      website: null,
    });
    await vi.waitFor(() => expect(email.sent).toHaveLength(2));
    const submitter = email.sent.find((message) => message.to === valid.email)!;
    // Anyone can type any address, so the confirmation repeats nothing they wrote.
    expect(submitter.text).not.toContain(valid.name);
    const admin = email.sent.find((message) => message.to === "admin@example.test")!;
    expect(admin.subject).toContain(valid.name);
    expect(admin.text).toContain("https://app.example.test/admin/plugins");
  });

  it("updates a pending submission for the same repository instead of queueing it twice", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit, email } = routes(prisma);
    await submit(valid);
    const again = await submit({ ...valid, description: "Better words." });
    expect(again.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe("Better words.");
    // Admins hear about the first one only.
    await vi.waitFor(() => expect(email.sent).toHaveLength(3));
    expect(email.sent.filter((message) => message.to === "admin@example.test")).toHaveLength(1);
  });

  it("never lets someone else replace a pending submission", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit } = routes(prisma);
    await submit(valid);
    const other = await submit({ ...valid, email: "someone@example.test", description: "Mine." });
    expect(other.status).toBe(201);
    expect(rows.map((row) => [row.email, row.description])).toEqual([
      [valid.email, valid.description],
      ["someone@example.test", "Mine."],
    ]);
  });

  it.each([
    ["a non-GitHub source", { source: "https://gitlab.com/acme/plugin" }, "source"],
    ["an http logo", { logo: "http://example.test/logo.svg" }, "logo"],
    ["an untested plugin", { tested: false }, "tested"],
    ["a missing email", { email: "" }, "email"],
  ])("rejects %s and names the field", async (_name, change, field) => {
    const { rows, prisma } = fakePrisma();
    const response = await routes(prisma).submit({ ...valid, ...change });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Array<{ field: string }> };
    expect(body.issues.map((issue) => issue.field)).toContain(field);
    expect(rows).toHaveLength(0);
  });

  it("limits submissions per address", async () => {
    const { prisma } = fakePrisma();
    const { submit } = routes(prisma, new EmailEmulator());
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await submit({ ...valid, source: `https://github.com/acme/plugin-${i}` })).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("reviewing submissions", () => {
  async function submitted() {
    const { rows, prisma } = fakePrisma();
    await routes(prisma).submit(valid);
    const email = new EmailEmulator();
    const deps = {
      prisma,
      email,
      onEmailError: (error: unknown) => {
        throw error;
      },
      env: {} as never,
    };
    return { rows, prisma, email, deps };
  }

  it("rejects with a reason the submitter is emailed", async () => {
    const { deps, email } = await submitted();
    const result = await reviewPluginSubmission(deps, {
      id: "sub-1",
      decision: "reject",
      reason: "The MCP server returned errors.",
    });
    expect(result).toMatchObject({
      status: "rejected",
      reason: "The MCP server returned errors.",
      // Admins open the branch and folder that was submitted.
      source: "https://github.com/acme/plugins/tree/main/tickets",
    });
    await vi.waitFor(() => expect(email.sent).toHaveLength(1));
    expect(email.sent[0]!.text).toContain("The MCP server returned errors.");
    expect(preview).not.toHaveBeenCalled();
  });

  it("approves the previewed commit and lists it in the marketplace", async () => {
    const { deps, prisma } = await submitted();
    preview.mockResolvedValue({
      source: { gitUrl: "https://github.com/acme/plugins", subdir: "tickets" },
      resolvedSha: SHA,
      mcpServers: [],
      skills: [{ name: "a" }, { name: "b" }],
      skipped: [],
    });
    await reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" });
    expect(await approvedPluginEntries(prisma)).toEqual([
      expect.objectContaining({
        name: "acme-tickets",
        displayName: "Acme Tickets",
        registry: "Rakazo",
        source: `https://github.com/acme/plugins@${SHA}#tickets`,
        installedSource: "https://github.com/acme/plugins#tickets",
        hasConnector: false,
        skillCount: 2,
      }),
    ]);
  });

  it("approves a plugin that leaves out a skill repeating a built-in one", async () => {
    const { deps, rows } = await submitted();
    preview.mockResolvedValue({
      source: { gitUrl: "https://github.com/acme/plugins" },
      resolvedSha: SHA,
      mcpServers: [],
      skills: [{ name: "a" }],
      skipped: [],
      builtinNames: ["interrogate"],
    });
    await reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" });
    expect(rows[0]!.status).toBe("approved");
  });

  it("refuses a plugin with nothing to install", async () => {
    const { deps, rows } = await submitted();
    preview.mockResolvedValue({
      source: { gitUrl: "https://github.com/acme/plugins" },
      resolvedSha: SHA,
      mcpServers: [],
      skills: [],
      skipped: [],
    });
    await expect(
      reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" }),
    ).rejects.toThrow("This plugin has no skills or MCP servers");
    expect(rows[0]!.status).toBe("pending");
  });

  it("keeps the first decision when another admin decides during the preview", async () => {
    const { deps, rows, email } = await submitted();
    preview.mockImplementation(async () => {
      rows[0]!.status = "rejected";
      return {
        source: { gitUrl: "https://github.com/acme/plugins" },
        resolvedSha: SHA,
        mcpServers: [],
        skills: [{ name: "a" }],
        skipped: [],
      };
    });
    await expect(
      reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(rows[0]!.status).toBe("rejected");
    expect(email.sent).toHaveLength(0);
  });

  it("does not approve a listing the author changed during the preview", async () => {
    const { deps, rows } = await submitted();
    preview.mockImplementation(async () => {
      Object.assign(rows[0]!, { name: "Changed", updatedAt: new Date() });
      return {
        source: { gitUrl: "https://github.com/acme/plugins" },
        resolvedSha: SHA,
        mcpServers: [],
        skills: [{ name: "tickets" }],
        skipped: [],
      };
    });
    await expect(
      reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(rows[0]!.status).toBe("pending");
  });

  it("keeps a plugin that would install only in part pending", async () => {
    const { deps, rows } = await submitted();
    preview.mockResolvedValue({
      source: { gitUrl: "https://github.com/acme/plugins" },
      resolvedSha: SHA,
      mcpServers: [],
      skills: [],
      skipped: [{ kind: "stdio_server" }],
    });
    await expect(
      reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" }),
    ).rejects.toThrow("This plugin would only install in part");
    expect(rows[0]!.status).toBe("pending");
  });
});

describe("integration page claims", () => {
  function reviewDeps(prisma: never) {
    return {
      prisma,
      email: new EmailEmulator(),
      onEmailError: (error: unknown) => {
        throw error;
      },
      env: {} as never,
    };
  }

  const confirmLink = (message: { text: string }) =>
    /https:\/\/app\.example\.test\/api\/v1\/integration-claims\/confirm\?token=[\w-]+/.exec(
      message.text,
    )![0];

  it("holds a claim out of review until the owner opens the emailed link", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit, open, email } = routes(prisma);
    expect((await submit(claim)).status).toBe(201);
    expect(rows[0]).toMatchObject({
      claim: "acme-tickets",
      status: "unconfirmed",
      source: null,
      testing: null,
      logo: null,
    });
    await vi.waitFor(() => expect(email.sent).toHaveLength(1));
    const [confirm] = email.sent;
    expect(confirm!.to).toBe(claim.email);
    expect(confirm!.text).not.toContain(claim.name);
    // Only the hash is stored, so a database read cannot confirm a claim.
    expect(confirm!.text).not.toContain(String(rows[0]!.confirmToken));
    expect(await listPluginSubmissions(prisma, "pending")).toEqual([]);

    const opened = await open(confirmLink(confirm!));
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe(
      "https://rakazo.com/integrations/acme-tickets/claim/?confirmed",
    );
    expect(rows[0]).toMatchObject({ status: "pending", confirmToken: null });
    await vi.waitFor(() => expect(email.sent).toHaveLength(2));
    expect(email.sent[1]).toMatchObject({
      to: "admin@example.test",
      subject: "New page claim: Acme Tickets",
    });
    // The admin RPC validates its output with this schema, so a claim must pass it.
    const pending = await listPluginSubmissions(prisma, "pending");
    expect(PluginSubmissionSchema.safeParse(pending[0]).success).toBe(true);
    // The link works once.
    expect((await open(confirmLink(confirm!))).status).toBe(404);
  });

  it("sends an expired link back to the claim form", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit, open, email } = routes(prisma);
    await submit(claim);
    await vi.waitFor(() => expect(email.sent).toHaveLength(1));
    rows[0]!.confirmExpiresAt = new Date(Date.now() - 1);
    const opened = await open(confirmLink(email.sent[0]!));
    expect(opened.headers.get("location")).toBe(
      "https://rakazo.com/integrations/acme-tickets/claim/?expired",
    );
    expect(rows[0]!.status).toBe("unconfirmed");
  });

  it.each([
    ["a free mail address", "someone@mail.example"],
    ["a lookalike domain", "owner@notacme.test"],
  ])("refuses a claim from %s", async (_name, address) => {
    const { rows, prisma } = fakePrisma();
    const response = await routes(prisma).submit({ ...claim, email: address });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Array<{ field: string }> };
    expect(body.issues.map((issue) => issue.field)).toEqual(["email"]);
    expect(rows).toHaveLength(0);
  });

  it("updates the owner's pending claim for the same page", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit } = routes(prisma);
    await submit(claim);
    expect((await submit({ ...claim, website: "https://acme.test" })).status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.website).toBe("https://acme.test");
  });

  it.each([
    ["acme.test", "https://acme.test"],
    ["acme.test:8443", "https://acme.test:8443"],
  ])("accepts the bare domain %s as the website", async (website, stored) => {
    const { rows, prisma } = fakePrisma();
    expect((await routes(prisma).submit({ ...claim, website })).status).toBe(201);
    expect(rows[0]!.website).toBe(stored);
  });

  it("only takes a page's URL slug, which is what the site matches", async () => {
    const { rows, prisma } = fakePrisma();
    const response = await routes(prisma).submit({ ...claim, claim: "acme_tickets" });
    expect(response.status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it("needs a website to link to", async () => {
    const { rows, prisma } = fakePrisma();
    const { website: _website, ...noWebsite } = claim;
    const response = await routes(prisma).submit(noWebsite);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Array<{ field: string }> };
    expect(body.issues.map((issue) => issue.field)).toEqual(["website"]);
    expect(rows).toHaveLength(0);
  });

  it("approves without previewing a plugin and publishes the newest claim per page", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit, claims } = routes(prisma);
    await submit(claim);
    await submit({ ...claim, email: "other@acme.test", website: "https://acme.test/app" });
    for (const row of rows) Object.assign(row, { status: "pending" });
    await reviewPluginSubmission(reviewDeps(prisma), { id: "sub-1", decision: "approve" });
    await reviewPluginSubmission(reviewDeps(prisma), { id: "sub-2", decision: "approve" });
    rows[0]!.reviewedAt = new Date(1);
    rows[1]!.reviewedAt = new Date(2);
    expect(preview).not.toHaveBeenCalled();
    expect(await approvedIntegrationClaims(prisma)).toEqual([
      { slug: "acme-tickets", website: "https://acme.test/app" },
    ]);
    expect((await claims()).claims).toHaveLength(1);
    // A claim never becomes an installable plugin.
    expect(await approvedPluginEntries(prisma)).toEqual([]);
  });
});
