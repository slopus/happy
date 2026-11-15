import { createServer, Socket } from "node:net";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { SmtpEmailProvider } from "./smtp-email.js";

describe("SmtpEmailProvider", () => {
  it("delivers product-authored content through the injected transport", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "message-1" }));
    const provider = new SmtpEmailProvider(
      { url: "smtps://user:secret@smtp.example.test:465", from: "Rakazo <no-reply@example.test>" },
      { transport: { sendMail } as never },
    );

    await provider.send({
      to: "ada@example.test",
      subject: "Reset password",
      text: "Plain text",
      html: "<p>HTML</p>",
    });

    expect(provider.describe().id).toBe("smtp");
    expect(sendMail).toHaveBeenCalledWith({
      from: "Rakazo <no-reply@example.test>",
      to: "ada@example.test",
      subject: "Reset password",
      text: "Plain text",
      html: "<p>HTML</p>",
    });
  });

  it("sends the configured reply-to address", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "message-1" }));
    const provider = new SmtpEmailProvider(
      {
        url: "smtps://smtp.example.test:465",
        from: "hello@example.test",
        replyTo: "founder@example.test",
      },
      { transport: { sendMail } as never },
    );
    await provider.send({ to: "ada@example.test", subject: "Welcome", text: "Hi" });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ replyTo: "founder@example.test" }),
    );
  });

  it("sends as a bot's own address, with its copies and reply-to", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "message-1" }));
    const provider = new SmtpEmailProvider(
      {
        url: "smtps://smtp.example.test:465",
        from: "hello@example.test",
        replyTo: "founder@example.test",
      },
      { transport: { sendMail } as never },
    );
    await provider.send({
      to: "ada@example.test",
      from: "Scout <scout@bots.test>",
      cc: ["grace@example.test"],
      replyTo: "scout@bots.test",
      subject: "Re: Order",
      text: "Hi",
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Scout <scout@bots.test>",
        cc: ["grace@example.test"],
        replyTo: "scout@bots.test",
      }),
    );
  });

  it("retries only failures that cannot have sent the message, then drains", async () => {
    const temporary = Object.assign(new Error("Try again later"), {
      code: "EENVELOPE",
      responseCode: 451,
    });
    const sendMail = vi
      .fn()
      .mockRejectedValueOnce(temporary)
      .mockRejectedValueOnce(temporary)
      .mockResolvedValue({ messageId: "message-1" });
    const sleep = vi.fn(async (_delayMs: number, _signal: AbortSignal) => undefined);
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      { transport: { sendMail } as never, sleep },
    );

    const delivery = provider.send({
      to: "ada@example.test",
      subject: "Reset password",
      text: "Use this link",
    });
    await provider.drain();
    await expect(delivery).resolves.toBeUndefined();

    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 1_000]);
  });

  // Each case runs real nodemailer against a scripted server and records every reply
  // the scripted sessions received, so the expected retry cannot be faked by a probe.
  it.each([
    {
      name: "a 4xx on RCPT",
      script: { rcpt: ["451 busy", "250 ok"] },
      sessions: 2,
      sent: 1,
      rcpt: ["451 busy", "250 ok"],
      end: ["250 queued"],
    },
    {
      name: "a 4xx after DATA",
      script: { end: ["451 later", "250 queued"] },
      sessions: 2,
      sent: 1,
      rcpt: ["250 ok", "250 ok"],
      end: ["451 later", "250 queued"],
    },
    {
      name: "a 5xx on RCPT",
      script: { rcpt: ["550 no such user"] },
      sessions: 1,
      sent: 0,
      rcpt: ["550 no such user"],
      end: [],
    },
    {
      name: "a drop after the message was sent",
      script: { end: [null] },
      sessions: 1,
      sent: 0,
      rcpt: ["250 ok"],
      end: [null],
    },
  ])("handles $name", async ({ script, sessions, sent, rcpt, end }) => {
    const server = await scriptedSmtpServer(script);
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      {
        createTransport: () =>
          nodemailer.createTransport({
            host: "127.0.0.1",
            port: server.port,
            ignoreTLS: true,
            greetingTimeout: 100,
            socketTimeout: 1_000,
          }),
        retryDelaysMs: [0, 0],
      },
    );
    try {
      const delivery = provider.send({ to: "ada@example.test", subject: "Hi", text: "Hello" });
      if (sent) await expect(delivery).resolves.toBeUndefined();
      else await expect(delivery).rejects.toThrow();
      expect(server.sessions()).toBe(sessions);
      expect(server.messages()).toBe(sent);
      expect(server.rcptReplies()).toEqual(rcpt);
      expect(server.endReplies()).toEqual(end);
    } finally {
      await server.close();
    }
  });

  it("reports a permanently refused recipient without retrying", async () => {
    const refused = Object.assign(new Error("Recipient command failed: 550 no such user"), {
      code: "EENVELOPE",
      command: "RCPT TO",
      responseCode: 550,
    });
    const sendMail = vi.fn().mockRejectedValue(refused);
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      { transport: { sendMail } as never, sleep: async () => undefined },
    );

    const delivery = provider.send({ to: "ada@example.test", subject: "Hi", text: "Hello" });
    await expect(delivery).rejects.toThrow("SMTP server rejected the recipient (550)");
    await expect(delivery).rejects.toBeInstanceOf(EmailRecipientRejectedError);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("retries a delivery whose connection never receives a greeting", async () => {
    // A relay that accepts TCP but never speaks. Every transport connection hits its
    // greeting timeout, so the provider must retry the greeting failure until the
    // retries run out. The relay keeps no state, so a probe from a local tool cannot
    // change what the test observes; the hook counts only this process's sockets.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SMTP test server did not bind");
    let transportConnections = 0;
    const realConnect = Socket.prototype.connect as (...args: unknown[]) => unknown;
    const countTransportSocket = function (this: Socket, ...args: unknown[]) {
      const socket = realConnect.apply(this, args);
      if (connectTargetPort(args) === address.port) transportConnections += 1;
      return socket;
    };
    const socketConnect = vi
      .spyOn(Socket.prototype, "connect")
      .mockImplementation(countTransportSocket as never);
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      {
        createTransport: () =>
          nodemailer.createTransport({
            host: "127.0.0.1",
            port: address.port,
            ignoreTLS: true,
            greetingTimeout: 100,
          }),
        retryDelaysMs: [0, 0],
      },
    );
    try {
      await expect(
        provider.send({ to: "ada@example.test", subject: "Hi", text: "Hello" }),
      ).rejects.toThrow(/greeting/i);
      // The transport itself connected three times: the greeting timeout was retried.
      expect(transportConnections).toBe(3);
    } finally {
      socketConnect.mockRestore();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("retries a refused connection", async () => {
    const server = await scriptedSmtpServer({});
    await server.close();
    const sleep = vi.fn(async (_delayMs: number, _signal: AbortSignal) => undefined);
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      {
        createTransport: () =>
          nodemailer.createTransport({ host: "127.0.0.1", port: server.port, ignoreTLS: true }),
        retryDelaysMs: [5],
        sleep,
      },
    );

    await expect(
      provider.send({ to: "ada@example.test", subject: "Hi", text: "Hello" }),
    ).rejects.toMatchObject({ code: "ESOCKET", originalCode: "ECONNREFUSED" });
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("rejects deliveries after draining begins", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "message-1" }));
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      { transport: { sendMail } as never },
    );

    await provider.drain();

    await expect(
      provider.send({
        to: "ada@example.test",
        subject: "Reset password",
        text: "Use this link",
      }),
    ).rejects.toThrow("SMTP provider is shutting down");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each(["succeeds", "fails"])(
    "closes once after an in-flight delivery %s, even with repeated drains",
    async (outcome) => {
      let finish!: () => void;
      const sendMail = vi.fn(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              outcome === "succeeds"
                ? resolve({ messageId: "message-1" })
                : reject(new Error("failed"));
          }),
      );
      const close = vi.fn();
      const provider = new SmtpEmailProvider(
        { url: "smtp://smtp.example.test", from: "a@example.test" },
        { transport: { sendMail, close } as never, retryDelaysMs: [] },
      );

      const delivery = provider.send({ to: "ada@example.test", subject: "Hi", text: "Hello" });
      const delivered =
        outcome === "succeeds"
          ? expect(delivery).resolves.toBeUndefined()
          : expect(delivery).rejects.toThrow("failed");
      const firstDrain = provider.drain();
      const secondDrain = provider.drain();
      expect(close).not.toHaveBeenCalled();
      await expect(
        provider.send({ to: "ada@example.test", subject: "Hi", text: "Hello" }),
      ).rejects.toThrow("SMTP provider is shutting down");
      expect(sendMail).toHaveBeenCalledOnce();

      finish();
      await delivered;
      await Promise.all([firstDrain, secondDrain]);
      await provider.drain();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("closes an idle transport and ignores a close failure", async () => {
    const close = vi.fn(() => {
      throw new Error("close failed");
    });
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      { transport: { close } as never },
    );

    await expect(provider.drain()).resolves.toBeUndefined();
    await expect(provider.drain()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes an idle pooled SMTP connection after delivery", async () => {
    const server = await scriptedSmtpServer({});
    const transport = nodemailer.createTransport({
      pool: true,
      host: "127.0.0.1",
      port: server.port,
      ignoreTLS: true,
    });
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      { transport },
    );
    try {
      await provider.send({ to: "ada@example.test", subject: "Hi", text: "Hello" });
      expect(server.messages()).toBe(1);
      expect(server.connections()).toBe(1);

      await provider.drain();
      await vi.waitFor(() => expect(server.connections()).toBe(0), { timeout: 1_000 });
    } finally {
      transport.close();
      await server.close();
    }
  });

  it("bounds graceful shutdown when delivery never settles", async () => {
    vi.useFakeTimers();
    try {
      const sendMail = vi.fn(() => new Promise<never>(() => undefined));
      const close = vi.fn();
      const provider = new SmtpEmailProvider(
        { url: "smtp://smtp.example.test", from: "a@example.test" },
        {
          transport: { sendMail, close } as never,
          retryDelaysMs: [],
          drainTimeoutMs: 100,
        },
      );

      void provider
        .send({ to: "ada@example.test", subject: "Reset password", text: "Use this link" })
        .catch(() => undefined);
      const draining = provider.drain();
      const alsoDraining = provider.drain();
      await vi.advanceTimersByTimeAsync(100);

      await expect(draining).resolves.toBeUndefined();
      await expect(alsoDraining).resolves.toBeUndefined();
      await provider.drain();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending retry when the drain deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const sendMail = vi.fn(async () =>
        Promise.reject(Object.assign(new Error("Try again later"), { responseCode: 421 })),
      );
      const close = vi.fn();
      const provider = new SmtpEmailProvider(
        { url: "smtp://smtp.example.test", from: "a@example.test" },
        {
          transport: { sendMail, close } as never,
          retryDelaysMs: [10_000],
          drainTimeoutMs: 100,
        },
      );

      const delivery = provider
        .send({
          to: "ada@example.test",
          subject: "Reset password",
          text: "Use this link",
        })
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      const draining = provider.drain();
      await vi.advanceTimersByTimeAsync(100);

      await expect(draining).resolves.toBeUndefined();
      await delivery;
      expect(sendMail).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsafe transports and incomplete sender configuration", () => {
    expect(
      () => new SmtpEmailProvider({ url: "https://smtp.example.test", from: "a@example.test" }),
    ).toThrow("SMTP_URL must use smtp:// or smtps://");
    expect(() => new SmtpEmailProvider({ url: "smtp://smtp.example.test", from: "" })).toThrow(
      "EMAIL_FROM is required",
    );
    expect(
      () =>
        new SmtpEmailProvider({
          url: "smtp://smtp.example.test?ignoreTLS=true",
          from: "a@example.test",
        }),
    ).toThrow("cannot disable TLS");
    expect(
      () =>
        new SmtpEmailProvider({
          url: "smtps://smtp.example.test?tls.rejectUnauthorized=false",
          from: "a@example.test",
        }),
    ).toThrow("cannot disable TLS");
  });

  it("requires STARTTLS for smtp URLs", () => {
    const createTransport = vi.fn((_url: string) => ({ sendMail: vi.fn() }) as never);

    new SmtpEmailProvider(
      { url: "smtp://user:secret@smtp.example.test:587", from: "a@example.test" },
      { createTransport },
    );

    expect(createTransport).toHaveBeenCalledOnce();
    const configuredUrl = new URL(String(createTransport.mock.calls[0]?.[0]));
    expect(configuredUrl.protocol).toBe("smtp:");
    expect(configuredUrl.searchParams.get("requireTLS")).toBe("true");
    expect(configuredUrl.searchParams.get("connectionTimeout")).toBe("10000");
    expect(configuredUrl.searchParams.get("greetingTimeout")).toBe("10000");
    expect(configuredUrl.searchParams.get("socketTimeout")).toBe("30000");
  });

  it("keeps timeouts set on SMTP_URL", () => {
    const createTransport = vi.fn((_url: string) => ({ sendMail: vi.fn() }) as never);

    new SmtpEmailProvider(
      { url: "smtps://smtp.example.test?connectionTimeout=2000", from: "a@example.test" },
      { createTransport },
    );

    const configuredUrl = new URL(String(createTransport.mock.calls[0]?.[0]));
    expect(configuredUrl.searchParams.getAll("connectionTimeout")).toEqual(["2000"]);
  });

  it("rejects an smtp relay that does not advertise STARTTLS", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("220 localhost ESMTP\r\n");
      socket.on("data", (chunk) => {
        for (const line of String(chunk).split("\r\n")) {
          if (/^(EHLO|HELO) /i.test(line)) socket.write("250-localhost\r\n250 HELP\r\n");
          else if (/^STARTTLS$/i.test(line)) socket.write("454 TLS not available\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SMTP test server did not bind");
    const provider = new SmtpEmailProvider(
      {
        url: `smtp://127.0.0.1:${address.port}?connectionTimeout=1000`,
        from: "a@example.test",
      },
      { retryDelaysMs: [] },
    );

    try {
      await expect(
        provider.send({ to: "ada@example.test", subject: "Reset", text: "Use this link" }),
      ).rejects.toThrow();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

type SmtpScript = {
  /** Reply to RCPT TO on each session; later ones accept. */
  rcpt?: string[];
  /** Reply after the message body, or null to drop the connection; later ones queue it. */
  end?: Array<string | null>;
};

/**
 * scriptedSmtpServer greets every connection, but only a client that opens the SMTP
 * handshake takes a script slot: a local tool probing the port speaks HTTP or hangs up
 * and is closed without consuming a scripted reply.
 */
async function scriptedSmtpServer(script: SmtpScript) {
  const sockets = new Set<Socket>();
  const rcptReplies: string[] = [];
  const endReplies: Array<string | null> = [];
  let sessions = 0;
  let messages = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.write("220 localhost ESMTP\r\n");
    let index = -1;
    let buffer = "";
    let inData = false;
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (index < 0 && !/^(EHLO|HELO) /i.test(line)) {
          socket.destroy();
          return;
        }
        if (index < 0) {
          index = sessions++;
          socket.write("250 localhost\r\n");
          continue;
        }
        if (inData) {
          if (line !== ".") continue;
          inData = false;
          const reply = script.end && index < script.end.length ? script.end[index]! : "250 queued";
          endReplies.push(reply);
          if (reply === null) {
            socket.destroy();
            return;
          }
          if (reply.startsWith("250")) messages += 1;
          socket.write(`${reply}\r\n`);
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write("250 localhost\r\n");
        else if (/^MAIL FROM:/i.test(line)) socket.write("250 ok\r\n");
        else if (/^RCPT TO:/i.test(line)) {
          const reply = script.rcpt?.[index] ?? "250 ok";
          rcptReplies.push(reply);
          socket.write(`${reply}\r\n`);
        } else if (/^DATA$/i.test(line)) {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (/^QUIT$/i.test(line)) socket.end("221 bye\r\n");
        else if (/^RSET$/i.test(line)) socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP test server did not bind");
  let closed = false;
  return {
    port: address.port,
    connections: () => sockets.size,
    sessions: () => sessions,
    rcptReplies: () => rcptReplies,
    endReplies: () => endReplies,
    messages: () => messages,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** The destination port of a `Socket.prototype.connect` call, in either argument shape. */
function connectTargetPort(args: unknown[]): number | undefined {
  let [first] = args;
  if (Array.isArray(first)) [first] = first; // node's normalized [options, listener] pair
  if (typeof first === "number") return first;
  if (first && typeof first === "object" && "port" in first) {
    const { port } = first as { port?: number | string };
    if (typeof port === "number") return port;
    if (typeof port === "string") return Number.parseInt(port, 10);
  }
  return undefined;
}
