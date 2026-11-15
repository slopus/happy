import { createCipheriv, createHash } from "node:crypto";
import { BUILTIN_TOOL_NAMES, FLEET_TOOL_NAMES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { agentConnectionTools, builtinAgentTools, DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { offersAgentConnectionTools, selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { inferScript, ScriptedAgentRuntime } from "./scripted-runtime.js";
import { EncryptedSecretStore } from "./secrets.js";

describe("secret store", () => {
  it("round-trips and never stores plaintext in ciphertext", async () => {
    const store = new EncryptedSecretStore("test-key");
    const record = await store.put("sk-or-v1-secretvalue", {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    });
    expect(record.ciphertext).not.toContain("sk-or-v1-secretvalue");
    expect(record.ciphertext).toMatch(/^v2:/);
    await expect(store.load(record.ciphertext, record.id)).resolves.toBe("sk-or-v1-secretvalue");
    await expect(store.load(record.ciphertext, "another-row")).rejects.toThrow();
  });

  it("keeps legacy ciphertext readable without rewriting it at startup", async () => {
    const key = "legacy-test-key";
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(key).digest(), iv);
    const encrypted = Buffer.concat([cipher.update("legacy-secret", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    const store = new EncryptedSecretStore(key);
    expect(await store.load(legacy, "secret-row")).toBe("legacy-secret");
  });

  it("rejects malformed v2 ciphertext when loading asynchronously", async () => {
    const store = new EncryptedSecretStore("test-key");
    await expect(store.load("v2:AAAA", "secret-row")).rejects.toThrow(
      "Encrypted secret is malformed",
    );
  });
});

describe("scripted runtime", () => {
  it("requests takeover for login work", () => {
    const script = inferScript("install the cli and sign in");
    expect(script?.some((t) => t.takeover)).toBe(true);
  });

  it("resumes after takeover without asking again", () => {
    const script = inferScript("install the cli and sign in", "takeover");
    expect(script?.some((t) => t.takeover)).toBe(false);
    expect(script?.some((t) => t.complete)).toBe(true);
  });

  it("resumes a skipped takeover without treating login as done", () => {
    const script = inferScript("install the cli and sign in", "takeover-skipped");
    expect(script?.some((t) => t.takeover)).toBe(false);
    expect(script?.some((t) => t.assistant?.includes("login was skipped"))).toBe(true);
  });

  it("does not infer a takeover checkpoint from ordinary task text", () => {
    const script = inferScript("ask me whether to record 'skipped the login'");
    expect(script?.some((t) => t.assistant?.includes("decision"))).toBe(true);
    expect(script?.some((t) => t.assistant?.includes("login was skipped"))).toBe(false);
  });

  it("routes destination/crm work through the connector", () => {
    const script = inferScript("write this to the destination crm as a note");
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "destination.write"))).toBe(
      true,
    );
  });

  it("spawns a named bot", () => {
    const script = inferScript("spawn a bot named Scout to research venues");
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "spawn_bot"))).toBe(true);
    expect(script?.some((t) => t.toolCalls?.some((c) => c.args.name === "Scout"))).toBe(true);
  });

  it("proposes a named space", () => {
    const script = inferScript("create a space named Customer support");
    expect(
      script?.some((turn) =>
        turn.toolCalls?.some(
          (call) => call.name === "create_space" && call.args.name === "Customer support",
        ),
      ),
    ).toBe(true);
  });

  it("runs an in-thread subagent", () => {
    const script = inferScript("run a subagent to summarize the notes");
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "run_subagent"))).toBe(true);
  });

  it("asks when it needs a decision", () => {
    const script = inferScript("ask me which city to use");
    expect(script?.some((t) => t.ask?.text.toLowerCase().includes("city"))).toBe(true);
  });

  it("stops hang work when aborted", async () => {
    const runtime = new ScriptedAgentRuntime();
    const ctx = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const types: string[] = [];
    const iterating = (async () => {
      for await (const event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "hang-1",
          prompt: "keep working until I stop you",
          instructions: "",
          history: [],
          tools: [],
          model: { provider: "scripted", id: "scripted" },
        },
        ctx,
      )) {
        types.push(event.type);
        if (event.type === "progress") await runtime.abort("hang-1");
      }
    })();
    await iterating;
    expect(types).toContain("progress");
    expect(types.at(-1)).toBe("done");
  });

  it("attaches a workspace file into the thread", () => {
    const script = inferScript("write notes/result.txt and attach it to the thread");
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "write_file"))).toBe(true);
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "attach_file"))).toBe(true);
  });

  it("observes the screen when asked", () => {
    const script = inferScript("observe your screen and type writer-desk");
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "computer_observe"))).toBe(true);
    expect(
      script?.some((t) =>
        t.toolCalls?.some(
          (c) =>
            c.name === "computer_act" &&
            Array.isArray(c.args.actions) &&
            c.args.actions.some(
              (action) =>
                action &&
                typeof action === "object" &&
                "kind" in action &&
                "text" in action &&
                action.kind === "type" &&
                action.text === "writer-desk",
            ),
        ),
      ),
    ).toBe(true);
  });

  it("archives a spawned bot by exact name", () => {
    const script = inferScript("delete the bot named Scout");
    expect(
      script?.some((t) =>
        t.toolCalls?.some((c) => c.name === "archive_bot" && c.args.confirm_name === "Scout"),
      ),
    ).toBe(true);
  });
});

describe("builtin tools", () => {
  it("keeps every bot management tool out of helper tool lists", () => {
    for (const name of FLEET_TOOL_NAMES) expect(DELEGATION_TOOL_NAMES.has(name), name).toBe(true);
  });

  it("gives a background helper only tools that read, never the computer, memory, skills or routines", () => {
    const options = {
      graphicalToolsAllowed: true,
      pageBrowserAllowed: true,
      groupId: null,
      semanticMemoryEnabled: true,
      cloudAgentEnabled: true,
      historyRetrievalEnabled: true,
      ticketBoardEnabled: true,
      messagingChannelRun: false,
    };
    const owner = selectBuiltinToolsForRun({ ...options, trigger: "user" }).map(
      (tool) => tool.name,
    );
    const helper = selectBuiltinToolsForRun({ ...options, trigger: "helper" }).map(
      (tool) => tool.name,
    );
    expect(helper.sort()).toEqual(
      [
        "board_tickets",
        "cloud_agent_status",
        "recall_memory",
        "scratchpad_list",
        "skill_read",
        "task_catalog",
        "ticket_get",
        "web_fetch",
        "web_search",
      ].sort(),
    );
    for (const name of [
      "shell",
      "computer_act",
      "browser_act",
      "write_file",
      "save_memory",
      "remember",
      "skill_create",
      "schedule_create",
      "run_subagent",
      "ask_user",
      "message_user",
      "search_history",
      "read_history",
    ]) {
      expect(owner, name).toContain(name);
      expect(helper, name).not.toContain(name);
    }
  });

  it("offers agent connections to a chat-linked bot's turns, but not to its helpers", () => {
    const linked = { hasMessagingIdentity: true, crossSpaceCommunication: true };
    expect(offersAgentConnectionTools({ ...linked, trigger: "user" })).toBe(true);
    expect(offersAgentConnectionTools({ ...linked, trigger: "helper" })).toBe(false);
    expect(offersAgentConnectionTools({ ...linked, trigger: "tickets" })).toBe(false);
    expect(
      offersAgentConnectionTools({ ...linked, crossSpaceCommunication: false, trigger: "user" }),
    ).toBe(false);
  });

  it("exposes the tools the executor actually applies", async () => {
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual(
      [...builtinAgentTools, ...agentConnectionTools].map((tool) => tool.name).sort(),
    );
    const options = {
      graphicalToolsAllowed: true,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: true,
      cloudAgentEnabled: true,
      historyRetrievalEnabled: true,
      messagingChannelRun: false,
      voiceCall: true,
    };
    const ticketNames = [
      "board_tickets",
      "ticket_get",
      "ticket_create",
      "ticket_update",
      "ticket_comment",
    ];
    const enabled = selectBuiltinToolsForRun({ ...options, ticketBoardEnabled: true }).map(
      (tool) => tool.name,
    );
    const disabled = selectBuiltinToolsForRun({ ...options, ticketBoardEnabled: false }).map(
      (tool) => tool.name,
    );
    expect(enabled.filter((name) => ticketNames.includes(name))).toEqual(ticketNames);
    expect(disabled).toEqual(enabled.filter((name) => !ticketNames.includes(name)));
    expect(
      selectBuiltinToolsForRun({
        ...options,
        ticketBoardEnabled: true,
        disabledBuiltinTools: ticketNames,
      }).map((tool) => tool.name),
    ).toEqual(disabled);
    const purchaseNames = ["request_purchase", "purchase_status", "paid_request"];
    expect(enabled.filter((name) => purchaseNames.includes(name))).toEqual([]);
    expect(
      selectBuiltinToolsForRun({ ...options, paymentWalletEnabled: true })
        .map((tool) => tool.name)
        .filter((name) => purchaseNames.includes(name)),
    ).toEqual(purchaseNames);
    const serviceNames = ["service_search", "service_call"];
    const services = (extra: Partial<Parameters<typeof selectBuiltinToolsForRun>[0]>) =>
      selectBuiltinToolsForRun({ ...options, ...extra })
        .map((tool) => tool.name)
        .filter((name) => serviceNames.includes(name));
    expect(services({})).toEqual([]);
    expect(services({ paidServicesEnabled: true })).toEqual(serviceNames);
  });
});
