import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { parsePluginSource, previewPluginInstall } from "@rakazo/adapters";
import {
  emailLocale,
  integrationClaimConfirmEmail,
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "@rakazo/auth";
import type {
  IntegrationClaim,
  PluginMarketplaceEntry,
  PluginSubmission,
  PluginSubmissionReview,
  PluginSubmissionStatus,
} from "@rakazo/contracts";
import {
  INTEGRATION_CLAIM_CONFIRM_PATH,
  INTEGRATION_CLAIMS_PATH,
  IntegrationClaimInputSchema,
  integrationPageUrl,
  PLUGIN_SUBMISSIONS_PATH,
  PluginSubmissionInputSchema,
} from "@rakazo/contracts";
import { pluginCategory } from "@rakazo/core";
import type { PluginSubmission as PluginSubmissionRow, PrismaClient } from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import { assertMcpRemoteEndpoint } from "./mcp-servers.js";
import type { RouterDeps } from "./router.js";
import { throttleKey, windowCounter } from "./window-counter.js";

const PLUGIN_REGISTRY = "Rakazo";
const MAX_BODY_BYTES = 32 * 1024;
const HOUR_MS = 60 * 60_000;
const SUBMISSIONS_PER_IP_PER_HOUR = 10;
// Anyone can type any address, so one inbox gets at most a few confirmations a day.
const CONFIRMATIONS_PER_EMAIL_PER_DAY = 3;
const CLAIM_LINK_MS = 24 * HOUR_MS;

type EmailDeps = Pick<RouterDeps, "email" | "onEmailError">;
type SourceRef = ReturnType<typeof parsePluginSource>;

// The provider tracks the send, so shutdown drains it; requests do not wait on delivery.
function sendLater({ email, onEmailError }: EmailDeps, message: Promise<TransactionalEmail>) {
  if (email) void message.then((built) => email.send(built)).catch((e) => onEmailError?.(e));
}

function sourceString(ref: SourceRef, pin: string | undefined): string {
  return ref.gitUrl + (pin ? `@${pin}` : "") + (ref.subdir ? `#${ref.subdir}` : "");
}

function browseUrl(source: string): string {
  const ref = parsePluginSource(source);
  return ref.ref || ref.subdir
    ? `${ref.gitUrl}/tree/${ref.ref ?? "HEAD"}${ref.subdir ? `/${ref.subdir}` : ""}`
    : ref.gitUrl;
}

/** A claimant who reads mail at the website's domain speaks for the app. */
function emailMatchesWebsite(email: string, website: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const host = new URL(website).hostname.toLowerCase().replace(/^www\./, "");
  return domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`);
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function pluginSubmissionDto(row: PluginSubmissionRow): PluginSubmission {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    website: row.website,
    logo: row.logo,
    claim: row.claim,
    source: row.source ? browseUrl(row.source) : null,
    description: row.description,
    testing: row.testing,
    status: row.status as PluginSubmissionStatus,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

type Issue = { field: string; message: string };

const issuesOf = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): Issue[] =>
  error.issues.map((issue) => ({
    field: issue.path.map(String).join("."),
    message: issue.message,
  }));

/** A plugin is matched to its pending resubmissions by repository, a claim by page. */
function submissionData(body: unknown) {
  if (body && typeof body === "object" && "claim" in body) {
    const parsed = IntegrationClaimInputSchema.safeParse(body);
    if (!parsed.success) return { issues: issuesOf(parsed.error) };
    const input = parsed.data;
    if (!emailMatchesWebsite(input.email, input.website)) {
      return { issues: [{ field: "email", message: "Use an email at your website's domain" }] };
    }
    return {
      match: { claim: input.claim },
      // A claim only links the page to the owner's site; the page keeps the catalog's words.
      data: { ...input, description: "", logo: null, source: null, testing: null },
    };
  }
  const parsed = PluginSubmissionInputSchema.safeParse(body);
  if (!parsed.success) return { issues: issuesOf(parsed.error) };
  const { tested: _tested, ...input } = parsed.data;
  try {
    const ref = parsePluginSource(input.source);
    if (new URL(ref.gitUrl).hostname !== "github.com")
      throw new Error("Use a public GitHub repository");
    const source = sourceString(ref, ref.ref);
    return {
      match: { source },
      data: { ...input, source, website: input.website ?? null, claim: null },
    };
  } catch (error) {
    return { issues: [{ field: "source", message: (error as Error).message }] };
  }
}

export function pluginSubmissionRoutes(
  deps: EmailDeps & {
    prisma: PrismaClient;
    adminEmails: readonly string[];
    webOrigin: string;
    clientIp: (c: Context) => string | undefined;
  },
) {
  const app = new Hono();
  const submissions = windowCounter(HOUR_MS);
  const confirmations = windowCounter(24 * HOUR_MS);
  const notifyAdmins = (row: PluginSubmissionRow) => {
    const reviewUrl = new URL("/admin/plugins", deps.webOrigin).href;
    for (const admin of deps.adminEmails) {
      sendLater(deps, pluginSubmissionAdminEmail(admin, row, reviewUrl));
    }
  };

  app.post(PLUGIN_SUBMISSIONS_PATH, async (c) => {
    if (submissions(throttleKey(deps.clientIp(c))) > SUBMISSIONS_PER_IP_PER_HOUR) {
      return c.json({ error: "Too many submissions. Try again later." }, 429, {
        "retry-after": String(HOUR_MS / 1000),
      });
    }
    const text = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
    if (text === null) return c.json({ error: "Submission is too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "Send the submission as JSON" }, 400);
    }
    const submission = submissionData(body);
    if (submission.issues) {
      return c.json({ error: "Invalid submission", issues: submission.issues }, 400);
    }
    const email = submission.data.email.toLowerCase();
    const claim = submission.data.claim;
    const token = claim ? randomBytes(32).toString("base64url") : null;
    // A claim waits unconfirmed, out of the review queue, until its emailed link is opened.
    const data = {
      ...submission.data,
      email,
      ...(token && {
        status: "unconfirmed",
        confirmToken: hashToken(token),
        confirmExpiresAt: new Date(Date.now() + CLAIM_LINK_MS),
      }),
    };
    const waiting = claim ? ["unconfirmed", "pending"] : ["pending"];
    // The same author resubmitting while it waits updates theirs; anyone else's is kept apart.
    const pending = await deps.prisma.pluginSubmission.findFirst({
      where: { ...submission.match, email, status: { in: waiting } },
      select: { id: true },
    });
    // A submission reviewed since the lookup keeps what the admin saw; this becomes a new one.
    const updated =
      pending &&
      (
        await deps.prisma.pluginSubmission.updateMany({
          where: { id: pending.id, status: { in: waiting } },
          data,
        })
      ).count > 0;
    const row = updated
      ? await deps.prisma.pluginSubmission.findUniqueOrThrow({ where: { id: pending.id } })
      : await deps.prisma.pluginSubmission.create({ data });
    if (confirmations(email) <= CONFIRMATIONS_PER_EMAIL_PER_DAY) {
      const locale = emailLocale(null, c.req.raw.headers);
      if (token) {
        const url = new URL(INTEGRATION_CLAIM_CONFIRM_PATH, deps.webOrigin);
        url.searchParams.set("token", token);
        sendLater(deps, integrationClaimConfirmEmail(email, url.href, locale));
      } else {
        sendLater(deps, pluginSubmissionReceivedEmail(email, locale));
      }
    }
    if (!updated && !claim) notifyAdmins(row);
    return c.json({ id: row.id, status: row.status }, updated ? 200 : 201);
  });

  // Opening the link proves the claimant reads mail at the app's domain; only then is it reviewed.
  app.get(INTEGRATION_CLAIM_CONFIRM_PATH, async (c) => {
    const token = c.req.query("token");
    const row = token
      ? await deps.prisma.pluginSubmission.findUnique({
          where: { confirmToken: hashToken(token) },
        })
      : null;
    if (!row?.claim || row.status !== "unconfirmed" || !row.confirmExpiresAt) {
      return c.text("This link was already used or is invalid.", 404);
    }
    if (row.confirmExpiresAt.getTime() < Date.now()) {
      return c.redirect(`${integrationPageUrl(row.claim)}claim/?expired`, 303);
    }
    const confirmed = await deps.prisma.pluginSubmission.updateMany({
      where: { id: row.id, status: "unconfirmed", confirmToken: row.confirmToken },
      data: { status: "pending", confirmToken: null, confirmExpiresAt: null },
    });
    if (confirmed.count > 0) notifyAdmins(row);
    return c.redirect(`${integrationPageUrl(row.claim)}claim/?confirmed`, 303);
  });

  // The marketing site reads this when it builds; a few minutes of staleness is fine.
  app.get(INTEGRATION_CLAIMS_PATH, async (c) =>
    c.json({ claims: await approvedIntegrationClaims(deps.prisma) }, 200, {
      "cache-control": "public, max-age=300",
    }),
  );

  return app;
}

export async function listPluginSubmissions(
  prisma: PrismaClient,
  status: PluginSubmissionStatus,
): Promise<PluginSubmission[]> {
  const rows = await prisma.pluginSubmission.findMany({
    where: { status },
    orderBy: { createdAt: status === "pending" ? "asc" : "desc" },
    take: 200,
  });
  return rows.map(pluginSubmissionDto);
}

export async function reviewPluginSubmission(
  deps: EmailDeps & Pick<RouterDeps, "prisma" | "pluginRepoFetcher" | "remoteConnectors" | "env">,
  input: PluginSubmissionReview,
  signal?: AbortSignal,
): Promise<PluginSubmission> {
  const row = await deps.prisma.pluginSubmission.findUnique({ where: { id: input.id } });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Submission not found" });
  if (row.status !== "pending") throw new ORPCError("CONFLICT", { message: "Already reviewed" });
  let listing = {};
  // A claim only changes how its page reads, so there is no plugin to check.
  if (input.decision === "approve" && row.source) {
    // Approval lists the commit that was checked, the same way the other registries pin theirs.
    const preview = await previewPluginInstall({
      source: row.source,
      signal,
      fetcher: deps.pluginRepoFetcher,
    }).catch(() => {
      throw new ORPCError("BAD_REQUEST", {
        message: "Could not preview a supported plugin from this repository",
      });
    });
    for (const server of preview.mcpServers) await assertMcpRemoteEndpoint(server.endpoint, deps);
    if (preview.skipped.some((part) => part.kind !== "unsupported_field")) {
      throw new ORPCError("BAD_REQUEST", { message: "This plugin would only install in part" });
    }
    if (!preview.skills.length && !preview.mcpServers.length) {
      throw new ORPCError("BAD_REQUEST", { message: "This plugin has no skills or MCP servers" });
    }
    listing = {
      pinnedSource: sourceString(preview.source, preview.resolvedSha),
      hasConnector: preview.mcpServers.length > 0,
      skillCount: preview.skills.length,
    };
  }
  const status = input.decision === "approve" ? "approved" : "rejected";
  const reason = input.decision === "reject" ? input.reason : null;
  // During the preview another admin may decide or the author may resubmit; only the reviewed
  // version is decided, once.
  const decided = await deps.prisma.pluginSubmission.updateMany({
    where: { id: row.id, status: "pending", updatedAt: row.updatedAt },
    data: { ...listing, status, reason, reviewedAt: new Date() },
  });
  if (decided.count === 0)
    throw new ORPCError("CONFLICT", { message: "Changed or already reviewed. Reload to see it." });
  // The decision is saved: the author's language (English without an account) only shapes the email.
  sendLater(
    deps,
    deps.prisma.user
      .findUnique({ where: { email: row.email }, select: { locale: true } })
      .catch(() => null)
      .then((author) =>
        pluginSubmissionReviewedEmail(
          { email: row.email, name: row.name, status, reason, claim: row.claim !== null },
          emailLocale(author?.locale),
        ),
      ),
  );
  return pluginSubmissionDto(
    await deps.prisma.pluginSubmission.findUniqueOrThrow({ where: { id: row.id } }),
  );
}

/** Newest approval per repository and folder. */
export async function approvedPluginEntries(
  prisma: PrismaClient,
): Promise<PluginMarketplaceEntry[]> {
  const rows = await prisma.pluginSubmission.findMany({
    where: { status: "approved", pinnedSource: { not: null } },
    orderBy: { reviewedAt: "desc" },
  });
  const listed = new Set<string>();
  return rows.flatMap((row) => {
    const source = row.pinnedSource!;
    const installedSource = sourceString(parsePluginSource(source), undefined);
    if (listed.has(installedSource)) return [];
    listed.add(installedSource);
    const name = row.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return [
      {
        id: `${PLUGIN_REGISTRY}:${source}`,
        name,
        displayName: row.name,
        description: row.description,
        keywords: [],
        category: pluginCategory({ name, category: null }),
        logo: row.logo,
        homepage: row.website,
        domains: [],
        registry: PLUGIN_REGISTRY,
        source,
        installedSource,
        hasConnector: row.hasConnector,
        skillCount: row.skillCount,
      },
    ];
  });
}

/** The newest approved claim for each integration page. */
export async function approvedIntegrationClaims(prisma: PrismaClient): Promise<IntegrationClaim[]> {
  const rows = await prisma.pluginSubmission.findMany({
    where: { status: "approved", claim: { not: null } },
    orderBy: { reviewedAt: "desc" },
    select: { claim: true, website: true },
  });
  const claimed = new Set<string>();
  return rows.flatMap((row) => {
    if (!row.claim || !row.website || claimed.has(row.claim)) return [];
    claimed.add(row.claim);
    return [{ slug: row.claim, website: row.website }];
  });
}
