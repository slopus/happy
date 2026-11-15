import type { BotSecretMetadata, LoginFieldInput, VaultPolicy } from "@rakazo/contracts";
import {
  BLOCKED_ITEM_ANSWER,
  encodeLoginSecret,
  UNCHOSEN_ITEM_ANSWER,
  VAULT_ALSO_ON_LIMIT,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { VaultBots } from "./vault.js";
import {
  secretAnswerRefusal,
  vaultAccessControls,
  vaultBotChoices,
  vaultBotsChoosable,
  vaultImportProblemList,
  vaultLoginSave,
  vaultSaveDrops,
} from "./vault.js";

// RFC 6238's test key, written in pieces so it never reads as a saved secret.
const TEST_KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);
const fields = [{ label: "Password", value: "saved-password-1", hidden: true }];
const withKey = encodeLoginSecret({ fields, otp: TEST_KEY });

describe("secretAnswerRefusal", () => {
  it("names only the server's two fixed refusals", () => {
    expect(secretAnswerRefusal(new Error(BLOCKED_ITEM_ANSWER))).toBe("blocked");
    expect(secretAnswerRefusal({ message: UNCHOSEN_ITEM_ANSWER })).toBe("unchosen");
    for (const error of [
      new Error(`${BLOCKED_ITEM_ANSWER} saved-password-1`),
      new Error("Could not save saved-password-1"),
      BLOCKED_ITEM_ANSWER,
      { message: 3 },
      null,
      undefined,
    ])
      expect(secretAnswerRefusal(error)).toBeUndefined();
  });
});

describe("vaultLoginSave", () => {
  const saved = { otp: TEST_KEY, alsoOn: "https://login.example.com" };
  const typed = { ...saved, fields: fields as LoginFieldInput[], asking: false };
  const value = (otp?: string) => encodeLoginSecret({ fields, ...(otp ? { otp } : {}) });
  // What both apps' editors send for a login, or that they can't send it yet.
  it.each([
    ["as shown: the shown key is left out, so the saved one stays", {}, { value: value() }],
    ["a new key is sent", { otp: ` ${"A".repeat(32)} ` }, { value: value("A".repeat(32)) }],
    ["an emptied key removes it", { otp: "" }, { value: encodeLoginSecret({ fields, otp: "" }) }],
    ["an unreadable key can't be sent", { otp: "not a key" }, undefined, true],
    [
      "changed sites are sent",
      { alsoOn: "https://a.example.com, https://b.example.com" },
      {
        value: value(),
        alsoOn: ["https://a.example.com", "https://b.example.com"],
      },
    ],
    ["emptied sites are sent as none", { alsoOn: "" }, { value: value(), alsoOn: [] }],
    ["a site that isn't HTTPS can't be sent", { alsoOn: "http://a.example.com" }, undefined],
    [
      "more sites than a login keeps can't be sent",
      {
        alsoOn: Array.from(
          { length: VAULT_ALSO_ON_LIMIT + 1 },
          (_, i) => `https://s${i}.example.com`,
        ).join(" "),
      },
      undefined,
    ],
    ["unchanged fields send no value", { fields: undefined, alsoOn: "" }, { alsoOn: [] }],
    ["a login without fields can't be sent", { fields: [] }, undefined],
    // A key is kept inside the login's value, so a changed one waits for the fields to be sent.
    [
      "a typed key without fields can't be sent",
      { fields: undefined, otp: "A".repeat(32) },
      undefined,
    ],
    [
      "an unreadable key without fields can't be sent",
      { fields: undefined, otp: "x" },
      undefined,
      true,
    ],
    ["an emptied key without fields can't be sent", { fields: undefined, otp: "" }, undefined],
    [
      "a chat answer without fields ignores a typed key",
      { fields: undefined, asking: true, otp: "A".repeat(32) },
      {},
    ],
    [
      "a chat answer without fields ignores an unreadable key",
      { fields: undefined, asking: true, otp: "x" },
      {},
    ],
    [
      "a chat answer without fields ignores an emptied key",
      { fields: undefined, asking: true, otp: "" },
      {},
    ],
    // A chat card's answer sends neither a key nor sites, whatever was typed.
    [
      "a chat answer sends the fields only",
      { asking: true, otp: "not a key", alsoOn: "x" },
      {
        value: value(),
      },
    ],
  ] as const)("%s", (_, change, save, ...unreadable) => {
    const result = vaultLoginSave({
      ...typed,
      ...change,
      savedOtp: saved.otp,
      savedAlsoOn: saved.alsoOn,
    });
    expect(result.save).toEqual(save);
    expect(result.keyUnreadable).toBe(unreadable.length > 0);
  });
});

describe("vaultSaveDrops", () => {
  const login = (fields: Partial<BotSecretMetadata> = {}) =>
    ({ preview: { username: "octo" }, ...fields }) as BotSecretMetadata;

  it("names what a server that doesn't know it dropped", () => {
    expect(vaultSaveDrops({ policy: "ask" }, login({ policy: "allow" }))).toEqual(["ask"]);
    expect(vaultSaveDrops({ policy: "off" }, login())).toEqual(["block"]);
    expect(vaultSaveDrops({ allBots: false }, login())).toEqual(["bots"]);
  });

  // Every combination sent to a server that knows none of it: each drop is named on its own, and
  // Allow, what such a server does anyway, is never one.
  const policies = [undefined, "allow", "ask", "off"] as const;
  const flags = [false, true];
  const combinations = policies.flatMap((policy) =>
    flags.flatMap((bots) =>
      flags.flatMap((alsoOn) => flags.map((key) => ({ policy, bots, alsoOn, key }))),
    ),
  );
  it.each(combinations)(
    "names each drop on its own: policy $policy, bots $bots, other sites $alsoOn, key $key",
    ({ policy, bots, alsoOn, key }) => {
      const sent = {
        ...(policy ? { policy } : {}),
        ...(bots ? { allBots: false } : {}),
        ...(alsoOn ? { alsoOn: ["https://www.example.test"] } : {}),
        value: key ? withKey : encodeLoginSecret({ fields }),
      };
      const expected = [
        ...(policy === "ask" ? ["ask"] : policy === "off" ? ["block"] : []),
        ...(bots ? ["bots"] : []),
        ...(alsoOn ? ["alsoOn"] : []),
        ...(key ? ["authenticatorKey"] : []),
      ];
      expect(vaultSaveDrops(sent, login())).toEqual(expected);
    },
  );

  it("names nothing a server kept, and no key when the preview couldn't be read", () => {
    expect(
      vaultSaveDrops(
        { policy: "ask", allBots: false, alsoOn: ["https://www.example.test"], value: withKey },
        login({
          policy: "ask",
          allBots: false,
          alsoOn: ["https://www.example.test"],
          preview: { username: "octo", otp: true },
        }),
      ),
    ).toEqual([]);
    expect(vaultSaveDrops({ value: withKey }, login({ preview: undefined }))).toEqual([]);
    expect(vaultSaveDrops({ value: encodeLoginSecret({ fields }) }, login())).toEqual([]);
  });
});

describe("vaultImportProblemList", () => {
  const problems = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      line: index + 1,
      label: `site-${index + 1}.example.test`,
      reason: "notHttps" as const,
    }));

  it("lists the first five left-out rows and counts the rest", () => {
    expect(vaultImportProblemList(problems(7))).toEqual({ shown: problems(5), more: 2 });
    expect(vaultImportProblemList(problems(5))).toEqual({ shown: problems(5), more: 0 });
    expect(vaultImportProblemList([])).toEqual({ shown: [], more: 0 });
  });
});

describe("vaultAccessControls", () => {
  const some: VaultBots = { allBots: false, botIds: ["bot-1"] };
  const every: VaultBots = { allBots: true, botIds: [] };
  const note = "This limits only this Space's bots.";

  it("offers Allow and Block to any item but a contact, and Ask first to a login or while set", () => {
    expect(vaultAccessControls({ kind: "login", policy: "allow", bots: [] }).policies).toEqual([
      "allow",
      "ask",
      "off",
    ]);
    expect(vaultAccessControls({ kind: "api_key", policy: "allow", bots: [] }).policies).toEqual([
      "allow",
      "off",
    ]);
    expect(vaultAccessControls({ kind: "card", policy: "ask", bots: [] }).policies).toEqual([
      "allow",
      "ask",
      "off",
    ]);
    expect(
      vaultAccessControls({ kind: "contact", policy: "allow", bots: [{ id: "bot-1" }] }),
    ).toEqual({
      policies: [],
      picker: false,
      note: undefined,
    });
  });

  // The picker's states: a choice of bots exists only while the item is limited (the server lists
  // none otherwise), and every bot of a choice must be shown before any choice is offered.
  const listed = [{ id: "bot-1" }, { id: "bot-2" }];
  const states: [string, VaultPolicy, VaultBots | undefined, { id: string }[], boolean][] = [
    ["every bot, bots to choose from", "allow", every, listed, true],
    ["a choice of shown bots", "ask", some, listed, true],
    ["a choice of none", "allow", { allBots: false, botIds: [] }, listed, true],
    ["blocked", "off", some, listed, false],
    ["no bots to choose from", "allow", every, [], false],
    ["a server that can't keep a choice", "allow", undefined, listed, false],
    // Unshown: archived bots not read, or a bot of another member's list.
    ["a chosen bot not shown", "allow", some, [{ id: "bot-2" }], false],
    [
      "a chosen bot of two not shown",
      "allow",
      { allBots: false, botIds: ["bot-1", "bot-3"] },
      listed,
      false,
    ],
    // Switched to Chosen in the editor, the choice is what was ticked there, all of them shown.
    [
      "every bot switched to a choice",
      "allow",
      { allBots: false, botIds: ["bot-2"] },
      listed,
      true,
    ],
  ];
  it.each(states)("offers the picker for %s: %s", (_label, policy, access, bots, picker) => {
    expect(vaultAccessControls({ kind: "login", policy, access, bots }).picker).toBe(picker);
  });

  it("says the note under chosen bots, or alone when none can be chosen, never for a blocked item", () => {
    const noted = (policy: "allow" | "ask" | "off", access?: VaultBots) =>
      vaultAccessControls({ kind: "api_key", policy, access, bots: [{ id: "bot-1" }], note }).note;
    expect(noted("allow", some)).toBe(note);
    expect(noted("allow", every)).toBeUndefined();
    expect(noted("off", some)).toBeUndefined();
    expect(noted("allow", undefined)).toBe(note);
    expect(noted("off", undefined)).toBeUndefined();
    expect(
      vaultAccessControls({
        kind: "api_key",
        policy: "allow",
        access: some,
        bots: [{ id: "bot-1" }],
      }).note,
    ).toBeUndefined();
  });
});

describe("vaultBotChoices", () => {
  const bot = (id: string, archivedAt: string | null = null) => ({ id, name: id, archivedAt });
  const archivedName = (name: string) => `${name} (archived)`;
  it.each([
    ["the active bots", [bot("a"), bot("b")], [], [], ["a", "b"]],
    ["an archived one the active list holds", [bot("a"), bot("b", "x")], [], ["b"], ["a"]],
    ["an archived chosen one, marked", [bot("a")], [bot("b", "x")], ["b"], ["a", "b (archived)"]],
    ["no archived one that isn't chosen", [bot("a")], [bot("b", "x")], [], ["a"]],
    ["no archived one twice", [bot("a")], [bot("a", "x")], ["a"], ["a"]],
  ])("offers %s", (_, bots, archived, chosen, names) => {
    expect(vaultBotChoices(bots, archived, chosen, archivedName).map(({ name }) => name)).toEqual(
      names,
    );
  });
});

describe("vaultBotsChoosable", () => {
  it.each([
    ["a vault not read yet", undefined, true],
    ["an empty vault", [], true],
    ["a server that lists an item's bots", [{}, { allBots: true }], true],
    ["a server that lists none", [{}, {}], false],
  ])("for %s: %s", (_, items, choosable) => {
    expect(vaultBotsChoosable(items)).toBe(choosable);
  });
});
