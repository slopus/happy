import { GENERATED_SECRET_SYMBOLS, GeneratedSecretRules } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { generateBotSecret, loadCommandVariables, resolveLoginFill } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { generateSecretValue } from "./secret-generator.js";
import { EncryptedSecretStore } from "./secrets.js";

const scope = { userId: "user-1", spaceId: "space-1" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const signup = {
  name: "example_account",
  type: "login",
  origin: "https://www.example.test/signup?ref=1",
  username: "person@example.test",
};

function generate(db: ReturnType<typeof fakeDatabase>, args: Record<string, unknown>) {
  return generateBotSecret({ prisma: db.prisma, secretStore, scope, args });
}

function escaped(characters: string) {
  return characters.replace(/[\\\]^-]/g, "\\$&");
}

describe("generateSecretValue", () => {
  it("defaults to 20 characters with every kind of character", () => {
    for (let run = 0; run < 50; run++) {
      const password = generateSecretValue(GeneratedSecretRules.parse({}));
      expect(password).toHaveLength(20);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(new RegExp(`[${escaped(GENERATED_SECRET_SYMBOLS)}]`));
    }
  });

  it("uses only the allowed kinds, length, and symbols", () => {
    const rules = GeneratedSecretRules.parse({
      length: 12,
      uppercase: false,
      allowedSymbols: "!_",
    });
    for (let run = 0; run < 50; run++) {
      const password = generateSecretValue(rules);
      expect(password).toMatch(/^[a-z0-9!_]{12}$/);
      expect(password).toMatch(/[!_]/);
      expect(password).toMatch(/[0-9]/);
    }
    expect(
      generateSecretValue(
        GeneratedSecretRules.parse({
          length: 8,
          lowercase: false,
          uppercase: false,
          symbols: false,
        }),
      ),
    ).toMatch(/^[0-9]{8}$/);
  });

  it("refuses rules no site could need", () => {
    expect(GeneratedSecretRules.safeParse({ length: 7 }).success).toBe(false);
    expect(GeneratedSecretRules.safeParse({ length: 129 }).success).toBe(false);
    expect(GeneratedSecretRules.safeParse({ allowedSymbols: "a!" }).success).toBe(false);
    expect(GeneratedSecretRules.safeParse({ allowedSymbols: " " }).success).toBe(false);
    expect(
      GeneratedSecretRules.safeParse({
        lowercase: false,
        uppercase: false,
        digits: false,
        symbols: false,
      }).success,
    ).toBe(false);
  });
});

describe("generate_secret", () => {
  const savedPassword = async (db: ReturnType<typeof fakeDatabase>) => {
    const fill = await resolveLoginFill({
      runId: "run-1",
      prisma: db.prisma,
      secretStore,
      scope,
      name: signup.name,
      field: "password",
    });
    if ("error" in fill) throw new Error(fill.error);
    return fill;
  };

  it("saves a login for the site and returns only what hides the password", async () => {
    const db = fakeDatabase();
    const { result, redactions } = await generate(db, {
      ...signup,
      rules: { length: 16, symbols: false },
    });
    expect(result).toEqual({
      saved: true,
      name: "example_account",
      origin: "https://www.example.test",
      auth: { type: "login" },
    });
    const { text: password, origin } = await savedPassword(db);
    expect(origin).toBe("https://www.example.test");
    expect(password).toMatch(/^[a-zA-Z0-9]{16}$/);
    expect(redactions).toContain(password);
    expect(db.rows()[0]!.ciphertext).not.toContain(password);
    expect(
      await resolveLoginFill({
        runId: "run-1",
        prisma: db.prisma,
        secretStore,
        scope,
        name: signup.name,
        field: "username",
      }),
    ).toMatchObject({ text: "person@example.test" });
  });

  it("never replaces a saved login", async () => {
    const db = fakeDatabase();
    await generate(db, signup);
    const { text: first } = await savedPassword(db);
    expect(await generate(db, signup)).toEqual({
      result: expect.objectContaining({
        error: expect.stringContaining("already saved for this site"),
      }),
    });
    expect(await generate(db, { ...signup, origin: "https://other.example.test" })).toEqual({
      result: { error: expect.stringContaining("already exists") },
    });
    expect((await savedPassword(db)).text).toBe(first);
  });

  it("keeps the first login when two calls race for the same name", async () => {
    const db = fakeDatabase();
    const results = await Promise.all([generate(db, signup), generate(db, signup)]);
    expect(results.filter(({ result }) => result.saved)).toHaveLength(1);
    expect(results.find(({ result }) => result.error)?.redactions).toBeUndefined();
    const saved = results.find(({ result }) => result.saved)!;
    expect(saved.redactions).toContain((await savedPassword(db)).text);
  });

  it("explains invalid input", async () => {
    const db = fakeDatabase();
    expect(await generate(db, { ...signup, origin: "http://www.example.test" })).toEqual({
      result: { error: expect.stringMatching(/HTTPS origin/) },
    });
    expect(await generate(db, { ...signup, rules: { length: 4 } })).toEqual({
      result: { error: expect.stringMatching(/^Invalid secret — rules\.length/) },
    });
    expect(await generate(db, { ...signup, username: "" })).toEqual({
      result: { error: expect.stringMatching(/username/) },
    });
    expect(await generate(db, { name: "account", type: "login", origin: signup.origin })).toEqual({
      result: { error: expect.stringMatching(/username: A login needs a username/) },
    });
    expect(
      await generate(db, { name: "db-password", type: "command", origin: signup.origin }),
    ).toEqual({ result: { error: expect.stringMatching(/no site or username/) } });
    expect(await generate(db, { name: "path", type: "command" })).toEqual({
      result: { error: expect.stringMatching(/reserved/) },
    });
    expect(db.rows()).toEqual([]);
  });

  it("also saves a login's password as a command variable for a CLI", async () => {
    const db = fakeDatabase();
    const { result, redactions } = await generate(db, { ...signup, command: true });
    expect(result).toEqual({
      saved: true,
      name: "example_account",
      origin: "https://www.example.test",
      auth: { type: "login" },
      command: {
        name: "example_account-password",
        auth: { type: "command" },
        variable: "EXAMPLE_ACCOUNT_PASSWORD",
      },
    });
    const { text: password } = await savedPassword(db);
    expect((await loadCommandVariables(db.prisma, secretStore, scope)).env).toEqual({
      EXAMPLE_ACCOUNT_PASSWORD: password,
    });
    expect(redactions).toContain(password);
  });

  it("saves neither when the command variable cannot be saved", async () => {
    const db = fakeDatabase();
    await generate(db, { name: "example_account_password", type: "command" });
    const put = vi.spyOn(secretStore, "put");
    const remove = vi.spyOn(secretStore, "delete");
    try {
      expect(await generate(db, { ...signup, command: true })).toEqual({
        result: { error: expect.stringContaining("already exported") },
      });
      const prepared = await Promise.all(put.mock.results.map(({ value }) => value));
      expect(prepared).toHaveLength(2);
      // Both values prepared for the refused pair are deleted; the saved variable's is not.
      expect(remove.mock.calls.map(([ref]) => ref).sort()).toEqual(
        prepared.map(({ ciphertext }) => ciphertext).sort(),
      );
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
    expect(db.rows().map((row) => row.name)).toEqual(["example_account_password"]);
    const taken = fakeDatabase();
    await generate(taken, { name: "example_account-password", type: "command" });
    expect(await generate(taken, { ...signup, command: true })).toEqual({
      result: { error: expect.stringContaining("example_account-password already exists") },
    });
    expect(await generate(db, { name: "db-password", type: "command", command: true })).toEqual({
      result: { error: expect.stringMatching(/Only a login/) },
    });
    expect(await generate(db, { ...signup, name: "a".repeat(56), command: true })).toEqual({
      result: { error: expect.stringMatching(/at most 55 characters/) },
    });
  });

  it("saves a command variable for shell commands without returning it", async () => {
    const db = fakeDatabase();
    const { result, redactions } = await generate(db, {
      name: "db-password",
      type: "command",
      rules: { length: 32, symbols: false },
    });
    expect(result).toEqual({
      saved: true,
      name: "db-password",
      auth: { type: "command" },
      variable: "DB_PASSWORD",
    });
    const { DB_PASSWORD } = (await loadCommandVariables(db.prisma, secretStore, scope)).env;
    expect(DB_PASSWORD).toMatch(/^[a-zA-Z0-9]{32}$/);
    expect(redactions).toContain(DB_PASSWORD);
    expect(await generate(db, { name: "db-password", type: "command" })).toEqual({
      result: expect.objectContaining({ error: expect.stringContaining("already saved") }),
    });
    expect((await loadCommandVariables(db.prisma, secretStore, scope)).env).toEqual({
      DB_PASSWORD,
    });
  });
});
