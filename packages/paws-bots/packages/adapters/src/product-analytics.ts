import { createHmac, randomUUID } from "node:crypto";
import type { ProductAnalytics } from "@rakazo/adapter-kit";
import { AnalyticsEvent } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";

/** Vendor configuration and translation stay here; no SDK ever reads the UI or request context. */
export function createProductAnalytics(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): ProductAnalytics | undefined {
  if (!env.ANALYTICS_PROVIDER || env.ANALYTICS_PROVIDER === "none") return undefined;
  if (env.ANALYTICS_PROVIDER === "emulator")
    return env.NODE_ENV === "production" ? undefined : logAnalytics();
  const key = env.ANALYTICS_KEY?.trim();
  const pseudonymSecret = env.ANALYTICS_PSEUDONYM_SECRET?.trim();
  let host: URL;
  try {
    host = new URL(env.ANALYTICS_HOST?.trim() || "https://us.i.posthog.com");
    if (
      env.ANALYTICS_PROVIDER !== "posthog" ||
      !key ||
      !pseudonymSecret ||
      host.protocol !== "https:" ||
      host.username ||
      host.password ||
      host.search ||
      host.hash
    )
      throw new Error();
  } catch {
    getLogger().warn(
      "Product analytics disabled: check ANALYTICS_PROVIDER, ANALYTICS_KEY, ANALYTICS_HOST and ANALYTICS_PSEUDONYM_SECRET.",
    );
    return undefined;
  }
  const endpoint = new URL("batch/", host.href.endsWith("/") ? host : `${host.href}/`);
  let pending: object[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;
  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (sending) await sending;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    sending = (async () => {
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: key, batch }),
          signal: AbortSignal.timeout(3_000),
          redirect: "error",
        });
        await response.body?.cancel();
        if (!response.ok) getLogger().warn("Product analytics delivery failed.");
      } catch {
        // Never log collector responses, request bodies, or credentials.
        getLogger().warn("Product analytics delivery failed.");
      }
    })();
    await sending;
    sending = undefined;
  };
  return {
    capture(userId, input, identity, experiments) {
      const parsed = AnalyticsEvent.safeParse(input);
      if (!parsed.success || typeof userId !== "string" || !userId || pending.length >= 256) return;
      if (identity && (!(identity.at instanceof Date) || !Number.isFinite(identity.at.getTime())))
        return;
      const { name, ...properties } = parsed.data;
      const hash = identity
        ? createHmac("sha256", pseudonymSecret!).update(`${name}:${identity.id}`).digest("hex")
        : undefined;
      pending.push({
        event: name,
        distinct_id: `product:${createHmac("sha256", pseudonymSecret!).update(`user:${userId}`).digest("hex")}`,
        uuid: hash
          ? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
          : randomUUID(),
        timestamp: (identity?.at ?? new Date()).toISOString(),
        properties: {
          ...properties,
          // PostHog reads an experiment's variant from `$feature/<key>`.
          ...Object.fromEntries(
            Object.entries(experiments ?? {}).map(([key, variant]) => [`$feature/${key}`, variant]),
          ),
          source: "product",
          $geoip_disable: true,
          $process_person_profile: false,
        },
      });
      timer ??= setTimeout(() => void flush(), 1_000);
      timer.unref();
    },
    flush,
  };
}

/** Local development only: write each allowed event to the log instead of sending it anywhere. */
function logAnalytics(): ProductAnalytics {
  return {
    capture(_userId, input, _identity, experiments) {
      const parsed = AnalyticsEvent.safeParse(input);
      if (parsed.success)
        getLogger().info("analytics event", { "analytics.event": parsed.data, experiments });
    },
    flush: async () => {},
  };
}
