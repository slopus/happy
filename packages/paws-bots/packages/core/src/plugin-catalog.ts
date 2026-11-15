import type { PluginMarketplaceEntry, PluginPart } from "@rakazo/contracts";
import { PluginPartSchema } from "@rakazo/contracts";

export const PLUGIN_CATEGORIES = [
  "productivity",
  "communication",
  "sales",
  "marketing",
  "finance",
  "people",
  "design",
  "code",
  "data",
  "ops",
] as const;

export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/** The chip-less filter behind the uncategorized section's View all. */
export const OTHER_PLUGINS = "other";

/** Registries use their own coarse labels; these are the ones that already say what a plugin is for. */
const REGISTRY_CATEGORIES: Record<string, PluginCategory> = {
  productivity: "productivity",
  development: "code",
  "developer-tools": "code",
  deployment: "ops",
  monitoring: "ops",
  observability: "ops",
  security: "ops",
  database: "data",
  media: "design",
  design: "design",
  marketing: "marketing",
  finance: "finance",
};

const NAMED_CATEGORIES: Record<PluginCategory, readonly string[]> = {
  productivity: [
    "google-drive",
    "google-calendar",
    "google-docs",
    "google-sheets",
    "google-slides",
    "outlook-calendar",
    "onedrive",
    "sharepoint",
    "todoist",
    "calendly",
    "calcom",
    "smartsheet",
    "wrike",
    "coda",
    "guru",
    "craft",
    "mem",
    "readwise",
    "trello",
    "lark",
    "feishu",
    "zoom",
    "fireflies",
    "otter",
    "fathom",
    "circleback",
    "plaud",
    "docusign",
    "typeform",
    "jotform",
    "gamma",
    "quo",
  ],
  communication: [
    "gmail",
    "outlook",
    "teams",
    "whatsapp-business",
    "ringcentral-phone",
    "ringcentral-chat",
    "intercom",
    "zoho-desk",
    "x",
    "stable",
  ],
  sales: [
    "salesforce",
    "salesforce-headless-360",
    "hubspot",
    "gong",
    "clay",
    "outreach",
    "amplemarket",
    "attio",
    "hunter",
    "zoho-crm",
    "highlevel",
    "pitchbook",
    "shopify-store",
    "jobber",
  ],
  marketing: [
    "google-ads",
    "klaviyo",
    "customer-io",
    "mailerlite",
    "brevo",
    "semrush",
    "ahrefs",
    "similarweb",
    "x-ads",
    "meta-ads",
    "tiktok-for-business",
    "buffer",
    "beehiiv",
    "meltwater",
    "profound",
    "helena",
    "omneky",
    "godaddy",
  ],
  finance: [
    "stripe",
    "navan",
    "brex",
    "xero",
    "finance",
    "webull",
    "sp-global",
    "interactive-brokers",
    "daloopa",
    "robinhood",
    "coinbase",
    "etoro-trading",
    "x-money",
    "quickbooks-online",
    "zoho-books",
    "square",
    "finary",
  ],
  people: ["ashby", "greenhouse", "juicebox", "upwork", "workable", "workday", "gusto"],
  design: ["figma", "framer", "excalidraw", "canva", "videogen", "html-css-to-image"],
  code: ["github", "playwright"],
  data: ["google-cloud-bigquery", "power-bi", "databricks-genie-one", "posthog-mcp", "statsig"],
  ops: ["vanta", "tailscale", "servicenow"],
};

const CATEGORY_BY_NAME = new Map(
  Object.entries(NAMED_CATEGORIES).flatMap(([category, names]) =>
    names.map((name) => [name, category as PluginCategory]),
  ),
);

/** Brands people look for first; plugins outside this list follow in catalog quality order. */
const RECOMMENDED = [
  "github",
  "stripe",
  "vercel",
  "figma",
  "hubspot",
  "salesforce",
  "sentry",
  "supabase",
  "calcom",
  "zoom",
  "datadog",
  "attio",
  "intercom",
  "cloudflare",
  "neon",
  "docusign",
];
const RECOMMENDED_RANK = new Map(RECOMMENDED.map((name, index) => [name, index]));

type CategorySource = Pick<PluginMarketplaceEntry, "name" | "category">;

export function pluginCategory(entry: CategorySource): PluginCategory | null {
  return (
    CATEGORY_BY_NAME.get(entry.name) ??
    (entry.category ? REGISTRY_CATEGORIES[entry.category] : undefined) ??
    null
  );
}

export function isRecommendedPlugin(entry: Pick<PluginMarketplaceEntry, "name">): boolean {
  return RECOMMENDED_RANK.has(entry.name);
}

function qualityRank(entry: PluginMarketplaceEntry): number {
  return (entry.logo ? 0 : 2) + (entry.description ? 0 : 1);
}

export function comparePlugins(a: PluginMarketplaceEntry, b: PluginMarketplaceEntry): number {
  const recommended =
    (RECOMMENDED_RANK.get(a.name) ?? RECOMMENDED.length) -
    (RECOMMENDED_RANK.get(b.name) ?? RECOMMENDED.length);
  return (
    recommended ||
    qualityRank(a) - qualityRank(b) ||
    a.displayName.localeCompare(b.displayName) ||
    a.id.localeCompare(b.id)
  );
}

function searchWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Every query word starts a word of the text, or the text with its separators removed. */
export function matchesWordPrefixes(text: string, query: string): boolean {
  const wanted = searchWords(query);
  const words = searchWords(text);
  const compact = words.join("");
  return wanted.every(
    (term) => compact.startsWith(term) || words.some((word) => word.startsWith(term)),
  );
}

export function matchesPluginQuery(
  entry: PluginMarketplaceEntry,
  query: string,
  categoryLabel = "",
): boolean {
  return matchesWordPrefixes(
    [
      entry.name,
      entry.displayName,
      entry.description,
      entry.category ?? "",
      categoryLabel,
      ...entry.keywords,
      ...entry.domains,
    ].join(" "),
    query,
  );
}

function brandKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The managed app a plugin is for, matched by name, so one brand is listed once. */
export function managedAppFor<T extends { name: string; slug: string }>(
  entry: Pick<PluginMarketplaceEntry, "name" | "displayName">,
  apps: readonly T[],
): T | undefined {
  const keys = new Set([brandKey(entry.displayName), brandKey(entry.name)]);
  return apps.find((app) => keys.has(brandKey(app.name)) || keys.has(brandKey(app.slug)));
}

/** Installs from before parts could be chosen added everything they had. */
export function installedPluginParts(config: Record<string, unknown>): PluginPart[] {
  const parsed = PluginPartSchema.array().safeParse(config.parts);
  return parsed.success ? parsed.data : ["connector", "skills"];
}
