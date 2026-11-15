import { parse } from "tldts";

/**
 * Who a request trusts, by site: the registrable domain, or the address itself for an IP literal.
 * Every subdomain of a site belongs to it, so `docs.example.com` is the same site as
 * `example.com`. Shared hosts on the public suffix list's private section count each tenant as its
 * own site, so trusting `alice.github.io` never trusts `attacker.github.io`.
 *
 * This lives behind its own entry point so clients that never decide policy skip the suffix list.
 */
export function hostSite(hostname: string): string | undefined {
  const host = normalizedHost(hostname);
  return host ? (siteOf(host, true) ?? host) : undefined;
}

/**
 * The registrable domain on ICANN suffixes only, for contacting a host without sending anything a
 * subdomain carries. A private suffix entry is not used here: anyone can request one for a domain
 * they control, which would let its subdomains reach their DNS.
 */
export function registrableDomain(hostname: string): string | undefined {
  const host = normalizedHost(hostname);
  return host ? siteOf(host, false) : undefined;
}

function normalizedHost(hostname: string): string | undefined {
  return hostname.trim().toLowerCase().replace(/\.$/, "") || undefined;
}

function siteOf(host: string, allowPrivateDomains: boolean): string | undefined {
  // URLs accept labels tldts would reject, such as `leak-.example.com`, so its check is off.
  const parsed = parse(host, { allowPrivateDomains, validateHostname: false });
  if (parsed.isIp || host.startsWith("[")) return host;
  return parsed.domain ?? undefined;
}

/** The site an http(s) URL is sent to, or undefined for anything else. */
export function urlSite(input: string): string | undefined {
  const url = httpUrl(input);
  return url ? hostSite(url.hostname) : undefined;
}

/** The URL normalized the way it is compared and sent, or undefined when it is not http(s). */
export function normalizedHttpUrl(input: string): string | undefined {
  return httpUrl(input)?.href;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// Delimit email-shaped text instead of requiring ASCII-only addresses or a public suffix.
const EMAIL_IN_TEXT =
  /(?:"(?:[^"\\\r\n]|\\.)*"|(?<![^\s<>()[\]\\,;:"@，；、！？])[^\s<>()[\]\\,;:"@，；、！？]+)@(?:\[[^\]\r\n]+\]|[^\s<>()[\]\\,;:"@，；、！？]+)/g;
const DOMAIN_IN_TEXT =
  /(?<![\p{L}\p{N}\p{M}_@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?\.)+\p{L}[\p{L}\p{N}\p{M}-]{0,62}[\p{L}\p{N}\p{M}](?![\p{L}\p{N}\p{M}_-])/gu;

/**
 * The sites a person named in their own words: http(s) links and bare domain names on a known
 * public suffix. Neither part of an email address names a site to fetch.
 */
export function sitesInText(text: string): Set<string> {
  const sites = new Set<string>();
  for (const [match] of text.matchAll(URL_IN_TEXT)) {
    const site = urlSite(match.replace(/[.,;:!?)\]}*~]+$/, ""));
    if (site) sites.add(site);
  }
  // A link grants only its own host: a domain in its path or query is not one the person named.
  // A domain-shaped email local part does not name a site either.
  const withoutLinksOrEmails = text.replace(URL_IN_TEXT, " ").replace(EMAIL_IN_TEXT, " ");
  for (const [match] of withoutLinksOrEmails.matchAll(DOMAIN_IN_TEXT)) {
    // Internationalized names are compared in the ASCII form a fetched URL's host takes.
    const hostname = httpUrl(`http://${match}`)?.hostname;
    if (!hostname) continue;
    const parsed = parse(hostname, { allowPrivateDomains: true });
    if ((parsed.isIcann || parsed.isPrivate) && parsed.domain) sites.add(parsed.domain);
  }
  return sites;
}

function httpUrl(input: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}
