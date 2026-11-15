import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import type { BotSecretDestination } from "@rakazo/contracts";
import { createStreamingRedactor, redactSecrets } from "@rakazo/core";
import { installAuditEventStore } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactAgentCommandResult } from "./agent-environment.js";
import {
  forgetBotSecret,
  listBotSecrets,
  loadCommandVariables,
  relabelVaultItem,
  requestWithBotSecret,
  resolveLoginFill,
  shellCommandEnvironment,
  storeBotSecret,
} from "./bot-secrets.js";
import { accountVault, fakeAuditLog, fakeDatabase } from "./bot-secrets.test-support.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { computerTools } from "./run-tools-computer.js";
import { EncryptedSecretStore } from "./secrets.js";
import { listVaultItemUses } from "./vault-activity.js";

afterEach(() => installAuditEventStore(undefined));

const scope = { userId: "user-1", spaceId: "space-1" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const command = { type: "command" } as const;

function save(
  db: ReturnType<typeof fakeDatabase>,
  name: string,
  plaintext: string,
  destination: Partial<BotSecretDestination> = {},
  saveScope = scope,
) {
  return storeBotSecret({
    prisma: db.prisma,
    secretStore,
    scope: saveScope,
    destination: { name, origin: "", auth: command, ...destination },
    plaintext,
  });
}

describe("storing a command variable", () => {
  it("stores the value with no site and decrypts it back", async () => {
    const db = fakeDatabase();
    await save(db, "netbird-setup-key", "fake-setup-key-1");
    const [row] = db.rows();
    expect(row).toMatchObject({ name: "netbird-setup-key", origin: "", auth: command });
    expect(row!.ciphertext).not.toContain("fake-setup-key-1");
    expect(await secretStore.load(row!.ciphertext, row!.id)).toBe("fake-setup-key-1");
  });

  it("accepts any value up to 16384 characters and nothing longer", async () => {
    const db = fakeDatabase();
    await expect(save(db, "big", "x".repeat(16_384))).resolves.toEqual(
      expect.objectContaining({ auth: command }),
    );
    await expect(save(db, "bigger", "x".repeat(16_385))).rejects.toThrow(
      "Invalid credential length",
    );
    await expect(save(db, "empty", "")).rejects.toThrow("Invalid credential length");
    await expect(save(db, "odd", "line one\nline two with 'quotes' $HOME ;")).resolves.toEqual(
      expect.objectContaining({ auth: command }),
    );
    await expect(save(db, "pair", "ok\uD800\uDC00")).resolves.toEqual(
      expect.objectContaining({ auth: command }),
    );
  });

  it("refuses a value an environment variable cannot carry", async () => {
    await expect(save(fakeDatabase(), "nul", "a\0b")).rejects.toThrow(
      "Credential cannot be used with this authentication method",
    );
    await expect(save(fakeDatabase(), "surrogate", "a\uD800b")).rejects.toThrow(
      "Credential cannot be used with this authentication method",
    );
  });

  it("refuses a reserved variable name with a clear message", async () => {
    const db = fakeDatabase();
    await expect(save(db, "ld_preload", "value")).rejects.toThrow(
      /Invalid credential destination — name: \$LD_PRELOAD is reserved/,
    );
    await expect(save(db, "path", "value")).rejects.toThrow(/\$PATH is reserved/);
    expect(db.rows()).toHaveLength(0);
  });

  it("refuses a site for a command variable", async () => {
    await expect(
      save(fakeDatabase(), "token", "value", { origin: "https://api.example.test" }),
    ).rejects.toThrow(/Invalid credential destination — origin/);
  });

  it("replaces the value but keeps the rule that a type change needs remove and re-add", async () => {
    const db = fakeDatabase();
    await save(db, "deploy-token", "first-value");
    await save(db, "deploy-token", "second-value");
    expect(db.rows()).toHaveLength(1);
    expect(await secretStore.load(db.rows()[0]!.ciphertext, db.rows()[0]!.id)).toBe("second-value");
    await expect(
      save(db, "deploy-token", "value", {
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      }),
    ).rejects.toThrow("Remove the existing credential before changing its destination");
  });

  it("refuses a second name exported as the same variable", async () => {
    const db = fakeDatabase();
    await save(db, "setup-key", "value-1");
    await expect(save(db, "setup_key", "value-2")).rejects.toThrow(
      /setup-key is already exported as \$SETUP_KEY/,
    );
  });
});

describe("command variables stay out of HTTP and page fills", () => {
  it("refuses secret_request before decrypting or sending", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-cli-token-1");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const load = vi.spyOn(secretStore, "load");
    try {
      const result = await requestWithBotSecret({
        prisma: db.prisma,
        secretStore,
        scope,
        request: { name: "cli-token", url: "https://api.example.test/v1" },
        signal: new AbortController().signal,
        remote: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      });
      expect(result).toEqual({
        error: expect.stringMatching(/^Credential cannot be used with this authentication method/),
      });
      expect(JSON.stringify(result)).toContain("$CLI_TOKEN");
      expect(load).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("refuses browser_act fill_secret", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-cli-token-1");
    expect(
      await resolveLoginFill({
        runId: "run-1",
        prisma: db.prisma,
        secretStore,
        scope,
        name: "cli-token",
        field: "password",
      }),
    ).toEqual({
      error: expect.stringMatching(/^Credential cannot be used with this authentication method/),
    });
  });
});

describe("list_secrets", () => {
  it("shows a command variable with its variable name and no value", async () => {
    const db = fakeDatabase();
    await save(db, "netbird-setup-key", "fake-setup-key-1");
    await save(db, "api", "fake-bearer-1", {
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    });
    const listed = await listBotSecrets(db.prisma, secretStore, scope);
    expect(listed).toEqual([
      expect.objectContaining({ name: "api", origin: "https://api.example.test" }),
      { name: "netbird-setup-key", auth: command, variable: "NETBIRD_SETUP_KEY" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("fake-setup-key-1");
  });

  it("reports an invalid stored command name separately from a reserved one", async () => {
    const db = fakeDatabase();
    const longName = "a".repeat(65);
    await db.prisma.vaultCredential.create({
      data: {
        id: "long-name",
        ...accountVault,
        name: longName,
        origin: "",
        auth: command,
        ciphertext: "unused",
      },
    });
    await db.prisma.vaultCredential.create({
      data: {
        id: "reserved-path",
        ...accountVault,
        name: "path",
        origin: "",
        auth: command,
        ciphertext: "unused",
      },
    });
    const listed = await listBotSecrets(db.prisma, secretStore, scope);
    expect(listed).toEqual([
      {
        name: longName,
        auth: command,
        error: `$${longName.toUpperCase()} is not a valid environment variable name and is not exported. Remove it and save it under another name.`,
      },
      {
        name: "path",
        auth: command,
        error: "$PATH is reserved and is not exported. Remove it and save it under another name.",
      },
    ]);
  });
});

describe("shell command environment", () => {
  // Mirrors the executor's shell tool: each command builds its environment through
  // shellCommandEnvironment, and its output is redacted with the values it registered.
  function commandRunner(db: ReturnType<typeof fakeDatabase>) {
    const runSecrets: string[] = [];
    const registerRedactions = (values: string[]) => {
      runSecrets.push(...values.filter((value) => !runSecrets.includes(value)));
    };
    return async (runScope = scope) => {
      const { env, unsetEnv } = await shellCommandEnvironment({
        prisma: db.prisma,
        secretStore,
        scope: runScope,
        registerRedactions,
      });
      // A fake sandbox whose command prints its whole environment.
      const printed = Object.entries(env)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n");
      return {
        env,
        unsetEnv,
        output: redactAgentCommandResult({ stdout: printed, stderr: printed, code: 0 }, runSecrets),
      };
    };
  }

  it("exports the vault's variables and redacts them from output", async () => {
    const db = fakeDatabase();
    await save(db, "netbird-setup-key", "fake-bot-setup-key");
    const { env, output } = await commandRunner(db)();
    expect(env).toEqual({ NETBIRD_SETUP_KEY: "fake-bot-setup-key" });
    expect(output.stdout).toContain("NETBIRD_SETUP_KEY=");
    expect(`${output.stdout}${output.stderr}`).not.toContain("fake-bot-setup-key");
  });

  it("decrypts each variable once per command, still redacting those the bot can't use", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-bot-token");
    await save(db, "blocked-token", "fake-blocked-token");
    db.rows().find((row) => row.name === "blocked-token")!.policy = "off";
    const load = vi.fn((ciphertext: string, recordId: string) =>
      secretStore.load(ciphertext, recordId),
    );
    const redactions: string[] = [];
    const { env } = await shellCommandEnvironment({
      prisma: db.prisma,
      secretStore: { load },
      scope: { ...scope, botId: "bot-1" },
      registerRedactions: (values) => redactions.push(...values),
    });
    expect(env).toEqual({ CLI_TOKEN: "fake-bot-token" });
    expect(redactions).toEqual(expect.arrayContaining(["fake-bot-token", "fake-blocked-token"]));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never exports a value the read that allowed it didn't see", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-allowed-token");
    const rows = db.rows();
    const index = rows.findIndex((row) => row.name === "cli-token");
    const replaced = await secretStore.put(
      "fake-blocked-replacement",
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: String(rows[index]!.id) },
    );
    const read = db.prisma.vaultCredential.findMany as unknown as (query: {
      where: unknown;
    }) => Promise<unknown>;
    // The owner replaces the value and blocks the item just after a read that checks who may use
    // it; a read that doesn't check runs later and sees the replacement.
    const findMany = async (query: { where: unknown }) => {
      if (!JSON.stringify(query.where).includes('"policy"')) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return read(query);
      }
      const result = await read(query);
      rows[index] = { ...rows[index]!, ciphertext: replaced.ciphertext, policy: "off" };
      return result;
    };
    const prisma = {
      ...db.prisma,
      vaultCredential: { ...db.prisma.vaultCredential, findMany },
    } as unknown as typeof db.prisma;
    const redactions: string[] = [];
    const { env } = await shellCommandEnvironment({
      prisma,
      secretStore,
      scope: { ...scope, botId: "bot-1" },
      registerRedactions: (values) => redactions.push(...values),
    });
    expect(env).toEqual({ CLI_TOKEN: "fake-allowed-token" });
    expect(redactions).toEqual(
      expect.arrayContaining(["fake-allowed-token", "fake-blocked-replacement"]),
    );
  });

  it("does not let one unencodable stored value abort the shell environment", async () => {
    const db = fakeDatabase();
    await save(db, "good-token", "fake-good-token");
    const bad = "pre\uD800post";
    await db.prisma.vaultCredential.create({
      data: {
        id: "stored-bad",
        ...accountVault,
        name: "bad-token",
        origin: "",
        auth: command,
        ciphertext: "stored-bad-ciphertext",
      },
    });
    // The cipher's UTF-8 round trip replaces an unpaired surrogate, so this loader
    // stands in for a row whose plaintext still contains one.
    const store = {
      async load(ciphertext: string, recordId: string) {
        return recordId === "stored-bad" ? bad : secretStore.load(ciphertext, recordId);
      },
    };
    const redactions: string[] = [];
    const { env } = await shellCommandEnvironment({
      prisma: db.prisma,
      secretStore: store,
      scope,
      registerRedactions: (values) => redactions.push(...values),
    });
    expect(env).toEqual({ BAD_TOKEN: bad, GOOD_TOKEN: "fake-good-token" });
    expect(new Set(redactions)).toEqual(
      new Set([
        bad,
        Buffer.from(bad).toString("base64"),
        "fake-good-token",
        Buffer.from("fake-good-token").toString("base64"),
      ]),
    );
  });

  it("leaves an unreadable variable unset and reports it", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-bot-token");
    await save(db, "good-token", "fake-good-token");
    const registerRedactions = vi.fn();
    const { env, unsetEnv } = await shellCommandEnvironment({
      prisma: db.prisma,
      secretStore: {
        async load(ciphertext, recordId) {
          if (recordId === db.rows().find((row) => row.name === "cli-token")!.id) {
            throw new Error("Cannot decrypt fake-bot-token");
          }
          return secretStore.load(ciphertext, recordId);
        },
      },
      scope,
      registerRedactions,
    });
    expect(env).toEqual({ GOOD_TOKEN: "fake-good-token" });
    expect(unsetEnv).toEqual(["CLI_TOKEN"]);
    expect(registerRedactions).toHaveBeenCalledExactlyOnceWith([
      "fake-good-token",
      Buffer.from("fake-good-token").toString("base64"),
    ]);
  });

  it("removes a failed bot credential from the desktop host environment", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-bot-token");
    const requestEnvironment = await shellCommandEnvironment({
      prisma: db.prisma,
      secretStore: {
        async load() {
          throw new Error("unreadable");
        },
      },
      scope,
      registerRedactions: vi.fn(),
    });
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-command-env-"));
    const desktop = new DesktopSandboxProvider({ root });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "test",
      userId: "test",
      signal: new AbortController().signal,
    };
    vi.stubEnv("CLI_TOKEN", "fake-host-token");
    try {
      const computer = await desktop.provision({ botId: "test", homePath: "/unused" }, context);
      const events = [];
      for await (const event of desktop.execute(
        computer,
        {
          argv: [
            process.execPath,
            "-e",
            "process.exit(Object.hasOwn(process.env, 'CLI_TOKEN') ? 1 : 0)",
          ],
          ...requestEnvironment,
        },
        context,
      ))
        events.push(event);
      expect(events).toEqual([{ type: "exit", code: 0 }]);
      await desktop.destroy(computer, context);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts encoded command credentials before any shell command registers them", async () => {
    const db = fakeDatabase();
    const value = "fake token/with+chars=";
    await save(db, "api-token", value);
    const runSecrets = (await loadCommandVariables(db.prisma, secretStore, scope)).redactions;
    const forms = [value, Buffer.from(value).toString("base64"), encodeURIComponent(value)];
    const redacted = redactSecrets(forms.join("\n"), runSecrets);
    for (const form of forms) expect(redacted).not.toContain(form);
  });

  it("redacts base64 and URL-encoded forms of a bot variable from command output", async () => {
    const db = fakeDatabase();
    const value = "fake token/with+chars=";
    await save(db, "api-token", value);
    const runSecrets: string[] = [];
    await shellCommandEnvironment({
      prisma: db.prisma,
      secretStore,
      scope,
      registerRedactions: (values) => runSecrets.push(...values),
    });
    const encoded = [Buffer.from(value).toString("base64"), encodeURIComponent(value)];
    const printed = encoded.join("\n");
    const output = redactAgentCommandResult({ stdout: printed, stderr: "", code: 0 }, runSecrets);
    for (const form of encoded) expect(output.stdout).not.toContain(form);
  });

  it("redacts the value a bot's command gets even if it is replaced right after the read", async () => {
    const db = fakeDatabase();
    await save(db, "api-token", "fake-first-token");
    // The vault changes right after the read whose values the command gets.
    const findMany = vi.mocked(db.prisma.vaultCredential.findMany);
    const read = findMany.getMockImplementation()!;
    let replaced = false;
    findMany.mockImplementation((async (args: Parameters<typeof read>[0]) => {
      const rows = (await read(args)).map((row) => ({ ...row }));
      if (!replaced && args?.select?.ciphertext) {
        replaced = true;
        await save(db, "api-token", "fake-second-token");
      }
      return rows;
    }) as never);
    const runSecrets: string[] = [];
    const command = () =>
      shellCommandEnvironment({
        prisma: db.prisma,
        secretStore,
        scope: { ...scope, botId: "bot-1" },
        registerRedactions: (values) => runSecrets.push(...values),
      });
    expect((await command()).env).toEqual({ API_TOKEN: "fake-first-token" });
    expect(redactSecrets("fake-first-token", runSecrets)).not.toMatch(/fake-/);
    // The next command gets the new value, and its output hides it too.
    expect((await command()).env).toEqual({ API_TOKEN: "fake-second-token" });
    expect(redactSecrets("fake-first-token fake-second-token", runSecrets)).not.toMatch(/fake-/);
  });

  it("applies a variable added, replaced, or removed between two commands", async () => {
    const db = fakeDatabase();
    const runCommand = commandRunner(db);
    expect((await runCommand()).env).toEqual({});

    await save(db, "later-token", "fake-later-token-1");
    const second = await runCommand();
    expect(second.env).toEqual({ LATER_TOKEN: "fake-later-token-1" });
    expect(second.output.stdout).not.toContain("fake-later-token-1");

    await save(db, "later-token", "fake-later-token-2");
    const third = await runCommand();
    expect(third.env).toEqual({ LATER_TOKEN: "fake-later-token-2" });
    expect(third.output.stdout).not.toContain("fake-later-token-2");

    await forgetBotSecret(db.prisma, scope, "later-token");
    expect((await runCommand()).env).toEqual({});
  });

  it("exports every command variable when a merged vault holds more than 100", async () => {
    const db = fakeDatabase();
    const value = await secretStore.put(
      "fake-merged-value",
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "merged" },
    );
    // Two bots' credentials merged into one vault can exceed the limit on new writes.
    for (let index = 0; index < 120; index += 1) {
      await db.prisma.vaultCredential.create({
        data: {
          id: "merged",
          ...accountVault,
          name: `tool-${index}`,
          origin: "",
          auth: command,
          ciphertext: value.ciphertext,
        },
      });
    }
    const { env: environment } = await loadCommandVariables(db.prisma, secretStore, scope);
    expect(Object.keys(environment)).toHaveLength(120);
    expect(environment.TOOL_119).toBe("fake-merged-value");
  });

  it("exports the command variables of the vault this Space uses", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-cli-token-1");
    await save(db, "api", "fake-bearer-1", {
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    });
    const otherSpace = { ...scope, spaceId: "space-2" };
    const exported = async (of: typeof scope) =>
      (await loadCommandVariables(db.prisma, secretStore, of)).env;
    // The account vault reaches every Space that has no vault of its own.
    expect(await exported(otherSpace)).toEqual({ CLI_TOKEN: "fake-cli-token-1" });
    db.useOwnVault("space-2");
    await save(db, "private-token", "fake-private-1", {}, otherSpace);
    expect(await exported(otherSpace)).toEqual({ PRIVATE_TOKEN: "fake-private-1" });
    expect(await exported(scope)).toEqual({ CLI_TOKEN: "fake-cli-token-1" });
    expect(await exported({ ...scope, userId: "user-2" })).toEqual({});
  });
});

describe("a shell command's use of its variables", () => {
  const value = "fake-shell-token-1";
  const computer = { id: "c1", botId: "bot-1", kind: "fake", providerRef: "c1" };
  type Sent = { env?: Record<string, string> };

  /** The shell tool as a bot's run calls it, on a computer that runs the command and exits. */
  function shell(db: ReturnType<typeof fakeDatabase>, botId = "bot-1") {
    const execute = vi.fn(async function* (_: unknown, _sent: Sent): AsyncGenerator<ProcessEvent> {
      yield { type: "stdout", data: "ok\n" };
      yield { type: "exit", code: 0 };
    });
    const ctx = {
      deps: {
        prisma: db.prisma,
        secretStore,
        sandbox: { execute },
        events: { append: async () => undefined },
      },
      run: { ...scope, botId, id: "run-1" },
      runId: "run-1",
      bot: { id: botId, name: "Deployer" },
      thread: { id: "thread-1" },
      context: { signal: new AbortController().signal },
      computer: {
        mode: "dedicated",
        graphical: false,
        stored: { id: "computer-1", kind: "fake" },
        checkpoint: { markDirty: () => {} },
        get: vi.fn(async () => computer),
      },
      secrets: [] as string[],
      state: {
        vaultUses: new Set<string>(),
        reply: { pendingProgress: "", redactor: createStreamingRedactor([]) },
      },
    };
    let finished: Promise<unknown> | undefined;
    const run = (command = "deploy") =>
      computerTools.shell!(
        ctx as never,
        {
          name: "shell",
          args: { command },
          executionId: "exec-1",
          observer: {
            onShellStillRunning: (completion: Promise<unknown>) => {
              finished = completion;
            },
          },
          finish: async (result: unknown) => result,
        } as never,
      );
    return { ctx, execute, run, finished: () => finished };
  }

  it("records each variable a command was sent with, once per attempt, with no site", async () => {
    const db = fakeDatabase();
    await save(db, "deploy-token", value);
    await save(db, "cli-token", "fake-shell-token-2");
    const rows = fakeAuditLog();
    const { ctx, execute, run } = shell(db);
    expect(await run()).toMatchObject({ stdout: "ok\n", code: 0 });
    expect(execute.mock.calls[0]![1].env).toEqual({
      CLI_TOKEN: "fake-shell-token-2",
      DEPLOY_TOKEN: value,
    });
    const id = (name: string) => db.rows().find((row) => row.name === name)!.id;
    expect(rows).toEqual(
      ["cli-token", "deploy-token"].map((name) =>
        expect.objectContaining({
          organizationId: "org-1",
          action: "credential.used",
          actorType: "bot",
          actorId: "bot-1",
          actorLabel: "Deployer",
          targetType: "vault_credential",
          targetId: id(name),
          targetLabel: name,
          runId: "run-1",
          threadId: "thread-1",
          // A shell is no site, so a command variable's use has none.
          metadata: { tool: "shell", scope: "account", name, kind: "command" },
        }),
      ),
    );
    // The attempt's later commands get them again, which is the same use; a new attempt's is new.
    await run();
    expect(rows).toHaveLength(2);
    ctx.state.vaultUses.clear();
    await run();
    expect(rows).toHaveLength(4);
    expect(JSON.stringify(rows)).not.toContain("fake-shell-token");
  });

  it("records nothing for a command the computer never got, or a redaction-only load", async () => {
    const db = fakeDatabase();
    await save(db, "deploy-token", value);
    const rows = fakeAuditLog();
    // Refused by the desktop-protection guard.
    const guarded = shell(db);
    Object.assign(guarded.ctx.computer, {
      graphical: true,
      stored: { id: "computer-1", kind: "vm" },
    });
    expect(await guarded.run("pkill chromium")).toEqual({
      error: expect.stringContaining("This command was not run"),
    });
    // The computer could not start.
    const stopped = shell(db);
    stopped.ctx.computer.get.mockRejectedValue(new Error("the computer is busy"));
    await expect(stopped.run()).rejects.toThrow("the computer is busy");
    for (const { execute } of [guarded, stopped]) expect(execute).not.toHaveBeenCalled();
    // What a run reads when it starts, to hide the values from what it shows.
    const loaded = await loadCommandVariables(db.prisma, secretStore, { ...scope, botId: "bot-1" });
    expect(loaded.redactions).toContain(value);
    expect(rows).toEqual([]);
  });

  it("records a use once the command was sent, also when it fails or keeps running", async () => {
    const db = fakeDatabase();
    await save(db, "deploy-token", value);
    const rows = fakeAuditLog();
    const failing = shell(db);
    failing.execute.mockImplementation(async function* () {
      yield { type: "stdout", data: "starting\n" };
      throw new Error("the connection to the computer was lost");
    });
    await expect(failing.run()).rejects.toThrow("the connection to the computer was lost");
    expect(rows).toHaveLength(1);

    // A sign-in prompt is handed back while the command is still running.
    const running = shell(db);
    let exit = () => {};
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    running.execute.mockImplementation(async function* () {
      yield { type: "stdout", data: "Open https://example.test/device and enter code ABCD-1234\n" };
      await exited;
      yield { type: "exit", code: 0 };
    });
    expect(await running.run("sign-in")).toMatchObject({ running: true, code: null });
    expect(rows).toHaveLength(2);
    // Its end is no second use.
    exit();
    await running.finished();
    expect(rows).toHaveLength(2);
  });

  it("gives and records only the variables the bot may use", async () => {
    const db = fakeDatabase();
    await save(db, "deploy-token", value);
    await save(db, "blocked-token", "fake-shell-token-2");
    await save(db, "other-bots-token", "fake-shell-token-3");
    await relabelVaultItem(db.prisma, scope, "blocked-token", { policy: "off" });
    await relabelVaultItem(db.prisma, scope, "other-bots-token", { bots: { botIds: ["bot-2"] } });
    const rows = fakeAuditLog();
    const sent = async (botId: string) => {
      rows.length = 0;
      const { execute, run } = shell(db, botId);
      await run();
      return {
        exported: Object.keys(execute.mock.calls[0]![1].env ?? {}),
        recorded: rows.map((row) => row.targetLabel),
      };
    };
    expect(await sent("bot-1")).toEqual({
      exported: ["DEPLOY_TOKEN"],
      recorded: ["deploy-token"],
    });
    expect(await sent("bot-2")).toEqual({
      exported: ["DEPLOY_TOKEN", "OTHER_BOTS_TOKEN"],
      recorded: ["deploy-token", "other-bots-token"],
    });
  });

  it("names a guest's account variable only in their own organization", async () => {
    const db = fakeDatabase();
    await save(db, "deploy-token", value);
    const rows = fakeAuditLog("guest");
    await shell(db).run();
    expect(rows.map((row) => [row.organizationId, row.targetLabel])).toEqual([
      ["org-1", null],
      ["org-own", "deploy-token"],
    ]);
    expect(rows[0]!.metadata).toEqual({ tool: "shell", scope: "account", kind: "command" });
    // Its owner's activity lists the two rows, neither with a site, as the one use they are.
    Object.assign(db.prisma, {
      auditEvent: { findMany: async () => rows },
      thread: { findMany: async () => [] },
    });
    expect(await listVaultItemUses(db.prisma, scope, "deploy-token")).toEqual([
      { at: expect.any(String), botName: "Deployer", site: null, chat: null },
    ]);
    // A variable in the Space's own vault is recorded in the Space's organization alone.
    rows.length = 0;
    db.useOwnVault("space-1");
    await save(db, "space-token", "fake-shell-token-2");
    await shell(db).run();
    expect(rows.map((row) => [row.organizationId, row.targetLabel])).toEqual([["org-1", null]]);
    expect(rows[0]!.metadata).toEqual({ tool: "shell", scope: "space", kind: "command" });
    expect(JSON.stringify(rows)).not.toMatch(/space-token|fake-shell-token/);
  });

  it("runs the command all the same when the audit log can't be written", async () => {
    const db = fakeDatabase();
    await save(db, "deploy-token", value);
    fakeAuditLog("member", true);
    expect(await shell(db).run()).toMatchObject({ stdout: "ok\n", code: 0 });
  });
});
