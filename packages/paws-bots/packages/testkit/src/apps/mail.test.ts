import { describe, expect, it } from "vitest";
import { DANA, SAM, studioFacts, studioMail } from "./fixtures/studio.js";
import { mailThreadId } from "./mail.js";

const now = new Date("2026-11-06T16:30:00Z");
const ok = (result: ReturnType<ReturnType<typeof studioMail>["call"]>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Record<string, any>;
};

describe("mail emulator", () => {
  it("searches with operators and paginates newest first", () => {
    const mail = studioMail({ now });
    const suppliers = ok(mail.call("search_threads", { query: "label:Suppliers newer_than:7d" }));
    expect(suppliers.threads.map((t: { subject: string }) => t.subject)).toEqual([
      "Delivery confirmation — PO-4465",
      "PO-4471 — revised dispatch date",
      "PO-4476 – colour confirmation needed",
      "Your order PO-4480 has shipped",
    ]);
    expect(
      ok(mail.call("search_threads", { query: 'from:dana "budget meeting"' })).threads,
    ).toHaveLength(1);
    expect(ok(mail.call("search_threads", { query: "has:attachment" })).threads[0].subject).toBe(
      "Delivery confirmation — PO-4465",
    );
    expect(
      ok(mail.call("search_threads", { query: "is:unread from:ostrava -news" })).threads,
    ).toHaveLength(1);
    expect(ok(mail.call("search_threads", { query: "PO-4419 OR PO-4480" })).threads).toHaveLength(
      2,
    );
    // OR binds its neighbours only; from:dana still applies to both.
    expect(
      ok(mail.call("search_threads", { query: "from:dana walnut OR GM" })).threads.map(
        (t: { subject: string }) => t.subject,
      ),
    ).toEqual(["Lobby seating — updated proposal?", "Juniper Row lobby — proposal v2"]);
    // A pasted link is a word, not an operator.
    const link = studioFacts(now).proposalV2Url;
    expect(ok(mail.call("search_threads", { query: link })).threads).toHaveLength(1);
    const unknown = mail.call("search_threads", { query: "name:budget" });
    expect(unknown.ok ? null : unknown.error.code).toBe("invalid_argument");
    // Rejected even when no thread is in scope to evaluate it against.
    for (const query of ["in:spam name:budget", "has:drive", "in:trash after:2026-13-45x"]) {
      const rejected = mail.call("search_threads", { query });
      expect(rejected.ok ? null : rejected.error.code).toBe("invalid_argument");
    }
    // A quoted OR is part of the phrase, not an operator.
    expect(ok(mail.call("search_threads", { query: '"PO-4419 OR PO-4480"' })).threads).toEqual([]);
    // Brackets are refused, not searched for literally.
    expect(mail.call("search_threads", { query: "(PO-4419 OR PO-4480) newer_than:7d" }).ok).toBe(
      false,
    );
    // "me" is the account, not any sender whose name contains "me" (e.g. Lumen).
    const fromMe = ok(mail.call("search_threads", { query: "from:me" })).threads;
    expect(fromMe.every((t: { from?: string }) => !/lumen/i.test(JSON.stringify(t)))).toBe(true);

    const first = ok(mail.call("search_threads", { query: "", max_results: 5 }));
    expect(first.threads).toHaveLength(5);
    const second = ok(
      mail.call("search_threads", { query: "", max_results: 5, page_token: first.next_page_token }),
    );
    expect(second.threads[0].id).not.toBe(first.threads[0].id);
    const stale = mail.call("search_threads", {
      query: "label:Clients",
      page_token: first.next_page_token,
    });
    expect(stale.ok ? null : stale.error.code).toBe("invalid_argument");
    expect(mail.writes).toEqual([]);
  });

  it("returns threads with reply headers and real dates", () => {
    const mail = studioMail({ now });
    const thread = ok(mail.call("get_thread", { thread_id: mailThreadId("juniper-v2") }));
    const [sent, reply] = thread.messages;
    expect(sent.headers.From).toBe(`${SAM.name} <${SAM.email}>`);
    expect(sent.headers.Date).toMatch(/^\w{3}, \d{2} \w{3} 2026 \d{2}:\d{2}:\d{2} \+0000$/);
    expect(reply.headers["In-Reply-To"]).toBe(sent.headers["Message-ID"]);
    expect(reply.headers.Subject).toBe("Re: Juniper Row lobby — proposal v2");
    expect(sent.body).toContain(studioFacts(now).proposalV2Url);
    const missing = mail.call("get_thread", { thread_id: "nope" });
    expect(missing.ok ? null : missing.error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("records drafts and sends as writes, with reply threading", () => {
    const mail = studioMail({ now });
    const thread = mailThreadId("juniper-update");
    const draft = ok(
      mail.call("create_draft", { to: DANA, body: "Hi Dana, v3 attached.", thread_id: thread }),
    );
    expect(mail.drafts.get(draft.id)).toMatchObject({
      threadId: thread,
      subject: "Re: Lobby seating — updated proposal?",
    });
    expect(mail.writesTo("create_draft")[0]?.after).toMatchObject({
      thread_id: thread,
      to: [DANA],
      headers: { "In-Reply-To": expect.stringMatching(/^<.+@juniperrow\.example>$/) },
    });
    ok(mail.call("update_draft", { draft_id: draft.id, body: "Hi Dana, v3 is here." }));
    ok(mail.call("send_draft", { draft_id: draft.id }));
    expect(mail.drafts.size).toBe(0);
    expect(mail.threads.get(thread)?.messages.at(-1)?.body).toBe("Hi Dana, v3 is here.");
    expect(mail.writes.map((w) => w.tool)).toEqual(["create_draft", "update_draft", "send_draft"]);

    const invalid = mail.call("create_draft", { to: "dana at juniper", body: "x" });
    expect(invalid.ok ? null : invalid.error.code).toBe("invalid_argument");
    const unknown = mail.call("create_draft", { to: DANA, body: "x", attachments: [] });
    expect(unknown.ok ? null : unknown.error.message).toMatch(/Unknown argument: attachments/);
    expect(mail.writes).toHaveLength(3);
  });

  it("rate-limits a tool for the fixture's number of calls, then recovers", () => {
    const mail = studioMail({
      now,
      faults: [{ tool: "search_threads", times: 1, retryAfterSeconds: 2 }],
    });
    const limited = mail.call("search_threads", { query: "PO-4471" });
    expect(limited.ok ? null : limited.error).toMatchObject({
      code: "rate_limited",
      status: 429,
      retry_after_seconds: 2,
    });
    expect(mail.call("search_threads", { query: "PO-4471" }).ok).toBe(true);
    expect(mail.calls.map((c) => c.error?.code ?? "ok")).toEqual(["rate_limited", "ok"]);
  });

  it("is deterministic for the same clock", () => {
    const a = studioMail({ now });
    const b = studioMail({ now });
    expect(a.call("search_threads", { max_results: 50 })).toEqual(
      b.call("search_threads", { max_results: 50 }),
    );
  });
});
