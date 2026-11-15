import { describe, expect, it } from "vitest";
import { hostSite, normalizedHttpUrl, registrableDomain, sitesInText, urlSite } from "./egress.js";

describe("urlSite", () => {
  it.each([
    ["https://example.com/page", "example.com"],
    ["https://docs.example.com/a?b=c", "example.com"],
    ["https://c2VjcmV0.leak.attacker.test/", "attacker.test"],
    ["https://news.bbc.co.uk/", "bbc.co.uk"],
    ["HTTPS://WWW.Example.COM.", "example.com"],
    ["http://203.0.113.7:8080/?q=x", "203.0.113.7"],
    ["http://[2001:db8::1]/", "[2001:db8::1]"],
    ["http://localhost:3000/", "localhost"],
  ])("puts %s on %s", (url, site) => {
    expect(urlSite(url)).toBe(site);
  });

  it.each(["ftp://example.com/", "javascript:alert(1)", "example.com", "not a url", ""])(
    "has no site for %s",
    (url) => {
      expect(urlSite(url)).toBeUndefined();
    },
  );

  it("counts each tenant of a shared host as its own site", () => {
    expect(hostSite("alice.github.io")).toBe("alice.github.io");
    expect(hostSite("docs.alice.github.io")).toBe("alice.github.io");
    expect(hostSite("attacker.github.io")).toBe("attacker.github.io");
  });

  it("contacts only the ICANN registrable domain, ignoring private suffixes", () => {
    expect(registrableDomain("c2VjcmV0.github.io")).toBe("github.io");
    expect(registrableDomain("c2VjcmV0.leak.example.co.uk")).toBe("example.co.uk");
  });

  it.each(["leak123-.attacker.com", "-leak.attacker.com", "le~ak.attacker.com"])(
    "reduces the hostname %s, which URLs accept, to its registrable domain",
    (hostname) => {
      expect(registrableDomain(hostname)).toBe("attacker.com");
      expect(hostSite(hostname)).toBe("attacker.com");
    },
  );

  it("has no registrable domain for a hostname without one", () => {
    expect(registrableDomain("localhost")).toBeUndefined();
    expect(registrableDomain("co.uk")).toBeUndefined();
    expect(registrableDomain("203.0.113.7")).toBe("203.0.113.7");
    expect(registrableDomain("[2001:db8::1]")).toBe("[2001:db8::1]");
  });
});

describe("normalizedHttpUrl", () => {
  it("normalizes http(s) URLs and refuses anything else", () => {
    expect(normalizedHttpUrl(" HTTPS://Example.com/a b ")).toBe("https://example.com/a%20b");
    expect(normalizedHttpUrl("file:///etc/passwd")).toBeUndefined();
  });
});

describe("sitesInText", () => {
  it("finds links and bare domains the person wrote", () => {
    expect(
      [
        ...sitesInText(
          "Read https://docs.example.com/guide, compare with shop.example.org. and (http://203.0.113.7/x).",
        ),
      ].sort(),
    ).toEqual(["203.0.113.7", "example.com", "example.org"]);
  });

  it.each([
    "visit **https://example.com**",
    "visit *https://example.com*",
    "visit ~~https://example.com~~",
    "visit **https://example.com/docs**",
    "visit **https://example.com**.",
  ])("names the site in a link wrapped in emphasis: %s", (text) => {
    expect([...sitesInText(text)]).toEqual(["example.com"]);
  });

  it("trusts only a link's host, not domains in its path or query", () => {
    expect([
      ...sitesInText("Summarize https://forum.example.org/topic/attacker.com?next=evil.net"),
    ]).toEqual(["example.org"]);
  });

  it("skips email addresses, file names and words without a public suffix", () => {
    expect([...sitesInText("Email bob@mail.example.com about notes.txt and index.ts")]).toEqual([]);
  });

  it.each([
    "ada.li@example.org",
    "ada.li@例子.测试",
    "ada.li@💩.la",
    "ada.li+tag@example.org",
    "ada.li+标签@example.org",
    "ada.li+📬@example.org",
    "ada.li/part@example.org",
    '"ada.li"@example.org',
    '"ada.li\\" contact"@example.org',
    "mailto:ada.li@example.org",
    "<ada.li@example.org>",
    "ada.li@localhost",
    "ada.li@[203.0.113.7]",
  ])("does not trust a domain in the email %s", (email) => {
    expect([...sitesInText(`Email ${email}`)]).toEqual([]);
  });

  it("keeps separately named sites alongside email addresses", () => {
    expect([
      ...sitesInText("Email ada.li@example.org, then visit ada.li and example.org."),
    ]).toEqual(["ada.li", "example.org"]);
  });

  it("keeps sites separated from internationalized email by punctuation or whitespace", () => {
    expect([...sitesInText("ada.li@例子.测试,example.com;example.org")]).toEqual([
      "example.com",
      "example.org",
    ]);
    expect([...sitesInText("example.com\u00a0ada.li+标签@例子.测试\u00a0example.org")]).toEqual([
      "example.com",
      "example.org",
    ]);
    expect([...sitesInText("example.com，ada.li@例子.测试；example.org")]).toEqual([
      "example.com",
      "example.org",
    ]);
  });

  it("reads internationalized domain names whole, as their ASCII form", () => {
    expect([...sitesInText("Visit münchen.de and bücher.de, then example.com")]).toEqual([
      "xn--mnchen-3ya.de",
      "xn--bcher-kva.de",
      "example.com",
    ]);
    expect([...sitesInText("See https://münchen.de/")]).toEqual(["xn--mnchen-3ya.de"]);
  });

  it("extracts explicit URL hosts before excluding email addresses", () => {
    expect([
      ...sitesInText(
        "Read https://ada.li@example.org/path and https://example.com/?email=ada.li@example.net",
      ),
    ]).toEqual(["example.org", "example.com"]);
  });
});
