import type { SignupAttribution as Attribution } from "@rakazo/contracts";
import { SIGNUP_ATTRIBUTION_COOKIE, SignupAttribution } from "@rakazo/contracts";
import { getDomain } from "tldts";
import { signupAttributionFromCookie } from "./signup-attribution.js";

/** First acquisition touch survives navigation and the hosted marketing → app handoff. */
export function rememberSignupAttribution(browser: {
  location: { href: string };
  document: { cookie: string; referrer: string };
}): void {
  try {
    const { document } = browser;
    const url = new URL(browser.location.href);
    const previous = signupAttributionFromCookie(document.cookie);
    if (Object.keys(previous).length) return;
    const next: Attribution = {};
    for (const [field, parameter] of [
      ["utmSource", "utm_source"],
      ["utmMedium", "utm_medium"],
      ["utmCampaign", "utm_campaign"],
      ["utmContent", "utm_content"],
      ["utmTerm", "utm_term"],
    ] as const) {
      const value = SignupAttribution.shape[field].safeParse(url.searchParams.get(parameter));
      if (value.success && value.data) next[field] = value.data;
    }
    if (document.referrer) {
      const referringDomain = new URL(document.referrer).hostname;
      const ownDomain = getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
      if (referringDomain !== ownDomain && !referringDomain.endsWith(`.${ownDomain}`)) {
        const value = SignupAttribution.shape.referringDomain.safeParse(referringDomain);
        if (value.success) next.referringDomain = value.data;
      }
    }
    if (!Object.keys(next).length) return;
    const domain = getDomain(url.hostname, { allowPrivateDomains: true });
    document.cookie = `${SIGNUP_ATTRIBUTION_COOKIE}=${encodeURIComponent(JSON.stringify(next))}; Path=/; Max-Age=2592000; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}${domain ? `; Domain=${domain}` : ""}`;
  } catch {
    // Optional measurement must not prevent navigation or authentication when cookies are blocked.
  }
}
