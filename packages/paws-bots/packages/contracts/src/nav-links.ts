import * as z from "zod";

/**
 * Operator-configured menu links (RAKAZO_NAV_LINKS) that open a same-origin page inside the app.
 * The operator's reverse proxy serves the path; Rakazo only frames it.
 */

/** App-owned paths a link must not frame. */
const RESERVED_PREFIXES = ["/app", "/api", "/rpc", "/novnc", "/health"];

function isSameOriginPath(path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\s]/.test(path)) return false;
  const url = new URL(path, "http://rakazo.invalid");
  if (url.origin !== "http://rakazo.invalid") return false;
  return !RESERVED_PREFIXES.some(
    (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
  );
}

export const NavLinkSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  label: z.string().trim().min(1).max(40),
  path: z.string().max(400).refine(isSameOriginPath),
  /** Lets the page use its own origin, and so the signed-in user's access to Rakazo. */
  trusted: z.boolean().default(false),
});
export type NavLink = z.infer<typeof NavLinkSchema>;

const NavLinksSchema = z
  .array(NavLinkSchema.strict())
  .max(10)
  .refine((links) => new Set(links.map((link) => link.id)).size === links.length);

export function parseNavLinks(value: string | undefined): NavLink[] {
  if (!value?.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new Error("RAKAZO_NAV_LINKS must be a JSON array");
  }
  const parsed = NavLinksSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Invalid RAKAZO_NAV_LINKS: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** Without allow-same-origin the page gets an opaque origin and cannot reach the app or its session. */
export function navLinkSandbox(link: Pick<NavLink, "trusted">): string {
  const base = "allow-scripts allow-forms allow-popups allow-downloads";
  return link.trusted ? `${base} allow-same-origin` : base;
}
