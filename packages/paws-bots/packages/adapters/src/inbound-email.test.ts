import { generateKeyPairSync } from "node:crypto";
import { dkimSign, sealMessage } from "mailauth";
import { describe, expect, it } from "vitest";
import type { InboundEmailResolver } from "./inbound-email.js";
import {
  INBOUND_EMAIL_MAX_SIGNATURES,
  INBOUND_EMAIL_TEXT_MAX_CHARS,
  readInboundEmail,
} from "./inbound-email.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");

/** DNS with one DKIM key, published as selector "s1" for each of these domains. */
const KEYED_DOMAINS = ["example.test", "news.example.test", "relay.test", "other-relay.test"];
const resolver: InboundEmailResolver = async (domain, rrtype) => {
  if (rrtype === "TXT" && KEYED_DOMAINS.some((keyed) => domain === `s1._domainkey.${keyed}`)) {
    return [[`v=DKIM1; k=rsa; p=${publicDer}`]];
  }
  throw Object.assign(new Error(`no ${rrtype} for ${domain}`), { code: "ENOTFOUND" });
};

function message(headers: string[], body = "Please summarize the attached report.\r\n") {
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

const plain = [
  "From: Ada Lovelace <ada@example.test>",
  "To: Bot <helper@bots.test>",
  "Cc: grace@example.test",
  "Subject: Weekly report",
  "Date: Thu, 05 Nov 2026 10:00:00 +0000",
  "Message-ID: <weekly-1@example.test>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
];

async function signed(raw: string, signingDomain = "example.test", headerList?: string) {
  const result = await dkimSign(raw, {
    ...(headerList ? { headerList } : {}),
    signatureData: [{ signingDomain, selector: "s1", privateKey: privatePem }],
  });
  expect(result.errors).toEqual([]);
  return result.signatures + raw;
}

const bytes = (raw: string) => new TextEncoder().encode(raw);

/** The relay's ARC set, recording which server it saw deliver the message. */
async function sealed(raw: string, spf: string, relay = "relay.test") {
  const seal = await sealMessage(Buffer.from(raw), {
    signingDomain: relay,
    selector: "s1",
    privateKey: privatePem,
    authResults: `mx.${relay}; dkim=pass header.d=example.test; spf=none smtp.helo=mail.test; ${spf}`,
    cv: "none",
  });
  return seal.toString() + raw;
}

/** How Microsoft 365 signs: no To or Cc. */
const RECIPIENTS_UNSIGNED = "From:Date:Subject:Message-ID:MIME-Version";

describe("readInboundEmail", () => {
  it("authenticates a message signed by its From domain", async () => {
    const email = await readInboundEmail(bytes(await signed(message(plain))), { resolver });

    expect(email.key).toMatch(/^dkim:/);
    expect(email).toMatchObject({
      from: { address: "ada@example.test", name: "Ada Lovelace" },
      authenticated: true,
      to: ["helper@bots.test"],
      cc: ["grace@example.test"],
      subject: "Weekly report",
      text: "Please summarize the attached report.",
      automated: false,
      attachments: [],
      messageId: "<weekly-1@example.test>",
      references: [],
    });
  });

  it("keeps the thread a reply answers", async () => {
    const email = await readInboundEmail(
      bytes(
        message([
          ...plain,
          "In-Reply-To: <weekly-0@example.test>",
          "References: <kickoff@example.test> <weekly-0@example.test>",
        ]),
      ),
      { resolver },
    );

    expect(email.references).toEqual(["<kickoff@example.test>", "<weekly-0@example.test>"]);
  });

  it("keeps a long thread's newest references", async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `<r-${index}@example.test>`);
    const email = await readInboundEmail(
      bytes(message([...plain, `References: ${ids.join(" ")}`])),
      {
        resolver,
      },
    );

    expect(email.references).toEqual(ids.slice(-20));
  });

  it("tells apart unsigned messages that reuse one Message-ID", async () => {
    const first = await readInboundEmail(bytes(message(plain, "Your code is 111111.\r\n")), {
      resolver,
    });
    const again = await readInboundEmail(bytes(message(plain, "Your code is 111111.\r\n")), {
      resolver,
    });
    const reused = await readInboundEmail(bytes(message(plain, "Your code is 222222.\r\n")), {
      resolver,
    });

    expect(again.key).toBe(first.key);
    expect(reused.key).not.toBe(first.key);
  });

  it("tells apart unsigned messages that differ only in their files", async () => {
    const withFile = (content: string) =>
      readInboundEmail(
        bytes(
          message(
            [
              ...plain.filter((line) => !line.startsWith("Content-Type")),
              'Content-Type: multipart/mixed; boundary="b"',
            ],
            [
              "--b",
              "Content-Type: text/plain",
              "",
              "Invoice attached.",
              "--b",
              "Content-Type: application/pdf",
              'Content-Disposition: attachment; filename="invoice.pdf"',
              "",
              content,
              "--b--",
              "",
            ].join("\r\n"),
          ),
        ),
        { resolver },
      );

    const [first, second] = await Promise.all([withFile("first"), withFile("second")]);

    expect(second.key).not.toBe(first.key);
  });

  it("does not authenticate unsigned, tampered or unaligned mail", async () => {
    const unsigned = await readInboundEmail(bytes(message(plain)), { resolver });
    const tampered = await readInboundEmail(
      bytes((await signed(message(plain))).replace("Please", "Kindly")),
      { resolver },
    );
    const otherDomain = await readInboundEmail(
      bytes(
        await signed(
          message(plain.map((line) => line.replace("ada@example.test", "ada@other.test"))),
        ),
      ),
      { resolver },
    );

    expect(unsigned.authenticated).toBe(false);
    expect(tampered.authenticated).toBe(false);
    expect(otherDomain).toMatchObject({
      authenticated: false,
      from: { address: "ada@other.test" },
    });
  });

  it("does not authenticate a subdomain signing for its parent's addresses", async () => {
    const email = await readInboundEmail(bytes(await signed(message(plain), "news.example.test")), {
      resolver,
    });

    expect(email.authenticated).toBe(false);
  });

  it("tells a key lookup that failed for now from a bad signature", async () => {
    const raw = bytes(await signed(message(plain)));
    const timeout: InboundEmailResolver = async () => {
      throw Object.assign(new Error("timed out"), { code: "ETIMEOUT" });
    };

    const later = await readInboundEmail(raw, { resolver: timeout });
    const missing = await readInboundEmail(bytes(message(plain)), { resolver });

    const elsewhere = await readInboundEmail(bytes(await signed(message(plain), "other.test")), {
      resolver: async (domain, rrtype) =>
        domain.endsWith("other.test") ? timeout(domain, rrtype) : resolver(domain, rrtype),
    });

    expect(later).toMatchObject({ authenticated: false, temporaryFailure: true });
    expect(missing).toMatchObject({ authenticated: false, temporaryFailure: false });
    // Another domain's signature failing for now never holds mail in the relay's queue.
    expect(elsewhere).toMatchObject({ authenticated: false, temporaryFailure: false });
  });

  it("keys a resent copy by its signature, whatever Message-ID it is given", async () => {
    const original = await signed(message(plain), "example.test", "From:To:Cc:Subject:Date");
    const resent = original.replace("<weekly-1@example.test>", "<another@example.test>");

    const first = await readInboundEmail(bytes(original), { resolver });
    const second = await readInboundEmail(bytes(resent), { resolver });

    expect(second.authenticated).toBe(true);
    expect(second.key).toBe(first.key);
  });

  it("does not authenticate recipients the signature leaves out or a To added on top", async () => {
    const toUnsigned = await readInboundEmail(
      bytes(await signed(message(plain), "example.test", "From:Subject:Date:Message-ID")),
      { resolver },
    );
    const injected = await readInboundEmail(
      bytes(
        `To: helper@bots.test\r\n${await signed(message(plain.filter((line) => !line.startsWith("To:"))))}`,
      ),
      { resolver },
    );

    expect(toUnsigned).toMatchObject({
      authenticated: false,
      unauthenticatedReason: "signature leaves out required headers",
    });
    expect(injected.authenticated).toBe(false);
  });

  it("rejects recipient-unsigned mail even with relay-sealed aligned SPF", async () => {
    const original = await signed(message(plain), "example.test", RECIPIENTS_UNSIGNED);
    for (const raw of [
      original,
      original.replace("To: Bot <helper@bots.test>", "To: Other <other@example.test>"),
    ]) {
      const email = await readInboundEmail(
        bytes(await sealed(raw, "spf=pass smtp.mailfrom=ada@example.test")),
        { resolver },
      );
      expect(email).toMatchObject({
        authenticated: false,
        unauthenticatedReason: "signature leaves out required headers",
      });
    }
  });

  it("does not authenticate recipient-unsigned mail resent from another server", async () => {
    const recipientsUnsigned = await signed(message(plain), "example.test", RECIPIENTS_UNSIGNED);
    const read = async (raw: string) =>
      (
        await readInboundEmail(bytes(raw), {
          resolver,
        })
      ).authenticated;

    // Replayed from someone else's server, sealed by another relay, or with a tampered seal.
    expect(
      await read(await sealed(recipientsUnsigned, "spf=pass smtp.mailfrom=eve@evil.test")),
    ).toBe(false);
    expect(
      await read(await sealed(recipientsUnsigned, "spf=fail smtp.mailfrom=ada@example.test")),
    ).toBe(false);
    expect(
      await read(
        await sealed(
          recipientsUnsigned,
          "spf=pass smtp.mailfrom=ada@example.test",
          "other-relay.test",
        ),
      ),
    ).toBe(false);
    const genuine = await sealed(recipientsUnsigned, "spf=pass smtp.mailfrom=ada@example.test");
    expect(
      await read(genuine.replace("spf=pass smtp.mailfrom=ada", "spf=pass smtp.mailfrom=eve")),
    ).toBe(false);
    // Without a signed Date, the age of the mail is unknown.
    expect(
      await read(
        await sealed(
          await signed(message(plain), "example.test", "From:Subject:Message-ID"),
          "spf=pass smtp.mailfrom=ada@example.test",
        ),
      ),
    ).toBe(false);
  });

  it("does not authenticate a subject the signature leaves out or one added on top", async () => {
    const subjectUnsigned = await readInboundEmail(
      bytes(await signed(message(plain), "example.test", "From:To:Cc:Date:Message-ID")),
      { resolver },
    );
    const injected = await readInboundEmail(
      bytes(`Subject: Wire the money\r\n${await signed(message(plain))}`),
      { resolver },
    );

    expect(subjectUnsigned.authenticated).toBe(false);
    expect(injected.authenticated).toBe(false);
  });

  it("marks auto-replies and list mail as automated", async () => {
    const cases = [
      "Auto-Submitted: auto-replied",
      "Precedence: bulk",
      "List-Id: <news.example.test>",
    ];
    for (const extra of cases) {
      const email = await readInboundEmail(bytes(message([...plain, extra])), { resolver });
      expect(email.automated, extra).toBe(true);
    }
    const hidden = await readInboundEmail(
      bytes(message([...plain, "Auto-Submitted: no", "Auto-Submitted: auto-replied"])),
      { resolver },
    );
    expect(hidden.automated).toBe(true);
    const human = await readInboundEmail(bytes(message([...plain, "Auto-Submitted: no"])), {
      resolver,
    });
    expect(human.automated).toBe(false);
  });

  it("never looks up keys for mail stuffed with signatures", async () => {
    const lookups: string[] = [];
    const counting: InboundEmailResolver = async (domain, rrtype) => {
      lookups.push(domain);
      return resolver(domain, rrtype);
    };
    let raw = await signed(message(plain));
    for (let index = 0; index < INBOUND_EMAIL_MAX_SIGNATURES; index++) {
      raw = await signed(raw, `d${index}.other.test`);
    }

    const email = await readInboundEmail(bytes(raw), { resolver: counting });

    expect(email.authenticated).toBe(false);
    expect(lookups).toEqual([]);
  });

  it("does not split an emoji where a long body is cut", async () => {
    const body = `${"a".repeat(INBOUND_EMAIL_TEXT_MAX_CHARS - 1)}😀 tail`;
    const raw = message(plain, `${body}\r\n`);

    const email = await readInboundEmail(bytes(raw), { resolver });

    expect(email.text).toBe(`${"a".repeat(INBOUND_EMAIL_TEXT_MAX_CHARS - 1)}\n[…]`);
  });

  it("refuses mail with more parts than real mail has", async () => {
    const boundary = "b2";
    const parts = Array.from(
      { length: 250 },
      () => `--${boundary}\r\nContent-Type: text/plain\r\n\r\nx`,
    ).join("\r\n");
    const raw = message(
      [
        ...plain.filter((line) => !line.startsWith("Content-Type")),
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ],
      `${parts}\r\n--${boundary}--\r\n`,
    );

    await expect(readInboundEmail(bytes(raw), { resolver })).rejects.toThrow(/part count/i);
  });

  it("reads HTML-only bodies, attachments and long text", async () => {
    const boundary = "b1";
    const raw = message(
      [
        ...plain.filter(
          (line) => !line.startsWith("Content-Type") && !line.startsWith("Message-ID"),
        ),
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ],
      [
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        `<p>Hello <b>bot</b> &amp; team: &euro;100 &#8364;5</p><script>steal()</script><p>${"x".repeat(INBOUND_EMAIL_TEXT_MAX_CHARS)}</p>`,
        `--${boundary}`,
        "Content-Type: text/csv",
        'Content-Disposition: attachment; filename="report.csv"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("a,b\n1,2\n").toString("base64"),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );

    const email = await readInboundEmail(bytes(await signed(raw)), { resolver });
    const unsigned = await readInboundEmail(bytes(raw), { resolver });

    // The inbox keeps unverified mail too, so its body is read the same way.
    expect(unsigned.text).toBe(email.text);
    expect(email.text.startsWith("Hello bot & team: €100 €5\n")).toBe(true);
    expect(email.text).not.toContain("steal");
    expect(email.text.endsWith("[…]")).toBe(true);
    expect(unsigned.key).toMatch(/^sha256:/);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ name: "report.csv", mimeType: "text/csv" });
    expect(new TextDecoder().decode(email.attachments[0]?.bytes)).toBe("a,b\n1,2\n");
  });
});
