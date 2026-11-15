import { describe, expect, it } from "vitest";

import { builtinAgentTools } from "./builtin-tools.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { jsonField, jsonSchemaParameters, parametersFor } from "./pi-runtime-tool-parameters.js";
import { prepareRequestSecretArguments } from "./pi-runtime-tools.js";

/**
 * The canonical schema must carry what the executor requires, so a hand-rolled
 * override fails here rather than silently dropping `credential` from the model.
 */
function toolNamed(name: string) {
  const tool = builtinAgentTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing builtin tool ${name}`);
  return tool;
}

function requestSecretSchema() {
  return toolNamed("request_secret").inputSchema as Record<string, unknown>;
}

function oneOfBranches(schema: Record<string, unknown>) {
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  return branches as Array<{
    properties?: Record<string, { properties?: Record<string, unknown> }>;
    required?: string[];
  }>;
}

const sampleCredential = {
  name: "github_pat",
  origin: "https://api.github.com",
  auth: { type: "bearer" },
};

describe("request_secret parameters", () => {
  it("tells the bot which login labels start visible, and that the user decides", () => {
    const { description } = toolNamed("request_secret");
    expect(description).toContain("ID, phone, email or username starts visible");
    expect(description).toContain("The user decides which fields are hidden");
  });

  it("exposes credential on the destination branch the executor persists", () => {
    const credentialBranch = oneOfBranches(requestSecretSchema()).find((branch) =>
      (branch.required ?? []).includes("credential"),
    );
    expect(credentialBranch?.properties).toHaveProperty("credential");
  });

  it("describes the credential destination fields the executor validates", () => {
    const credentialBranch = oneOfBranches(requestSecretSchema()).find((branch) =>
      (branch.required ?? []).includes("credential"),
    );
    const credential = credentialBranch?.properties?.credential?.properties ?? {};
    // normalizeSecretDestination rejects the call unless all three resolve.
    expect(Object.keys(credential).sort()).toEqual(["auth", "name", "origin"]);
  });

  it("tells the model what origin is for, since a command variable leaves it optional", () => {
    const credentialBranch = oneOfBranches(requestSecretSchema()).find((branch) =>
      (branch.required ?? []).includes("credential"),
    );
    const origin = credentialBranch?.properties?.credential?.properties?.origin as
      | { description?: string }
      | undefined;
    expect(origin?.description).toBeTruthy();
  });

  it("exposes connectionId on the mutually exclusive alternative branch", () => {
    const connectionBranch = oneOfBranches(requestSecretSchema()).find((branch) =>
      (branch.required ?? []).includes("connectionId"),
    );
    expect(connectionBranch?.properties).toHaveProperty("connectionId");
  });

  it("rejects both destinations and neither, matching the executor", () => {
    const schema = requestSecretSchema();
    expect(() =>
      parseConnectorToolArgs(schema, {
        label: "GitHub PAT",
        purpose: "api_key",
        credential: sampleCredential,
        connectionId: "conn_1",
      }),
    ).toThrow();
    expect(() =>
      parseConnectorToolArgs(schema, { label: "GitHub PAT", purpose: "api_key" }),
    ).toThrow();
    expect(
      parseConnectorToolArgs(schema, {
        label: "GitHub PAT",
        purpose: "api_key",
        credential: sampleCredential,
      }),
    ).toMatchObject({ credential: sampleCredential });
    expect(
      parseConnectorToolArgs(schema, {
        label: "c",
        purpose: "otp",
        connectionId: "abc",
      }),
    ).toMatchObject({ connectionId: "abc" });
  });

  it("offers a code request by oneTimeCode alone, and rejects it beside a credential", () => {
    const schema = requestSecretSchema();
    expect(
      parseConnectorToolArgs(schema, {
        label: "Code",
        purpose: "otp",
        oneTimeCode: { origin: "https://login.example.test" },
      }),
    ).toMatchObject({ oneTimeCode: { origin: "https://login.example.test" } });
    for (const extra of [{ credential: sampleCredential }, { connectionId: "conn_1" }]) {
      expect(() =>
        parseConnectorToolArgs(schema, {
          label: "Code",
          purpose: "otp",
          oneTimeCode: { origin: "https://login.example.test" },
          ...extra,
        }),
      ).toThrow();
    }
    expect(() =>
      parseConnectorToolArgs(schema, { label: "Code", purpose: "otp", oneTimeCode: {} }),
    ).toThrow();
  });

  it("rejects connectionId with replace, which belongs only on the credential branch", () => {
    expect(() =>
      parseConnectorToolArgs(requestSecretSchema(), {
        label: "c",
        purpose: "otp",
        connectionId: "abc",
        replace: true,
      }),
    ).toThrow();
  });

  it("keeps exclusivity when converted for the PI model", () => {
    const converted = jsonSchemaParameters(requestSecretSchema()) as {
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    // Type.Union serializes as anyOf; the model must still see three exclusive shapes.
    const variants = converted.anyOf ?? converted.oneOf ?? [];
    expect(variants.length).toBe(3);
  });

  it("keeps converted destination variants closed so both destinations cannot match", () => {
    const converted = jsonSchemaParameters(requestSecretSchema()) as {
      anyOf?: Array<{ additionalProperties?: unknown }>;
      oneOf?: Array<{ additionalProperties?: unknown }>;
    };
    const variants = converted.anyOf ?? converted.oneOf ?? [];
    expect(variants).toHaveLength(3);
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("exposes OpenAI-compatible parameters.type object for local servers", () => {
    // LM Studio and similar validators reject parameters without type === "object",
    // and Anthropic rejects a root union, so the wire shape is one object with both
    // destinations; the executor still enforces credential XOR connectionId.
    const wire = JSON.parse(JSON.stringify(parametersFor(toolNamed("request_secret")))) as {
      type?: unknown;
      properties?: Record<string, unknown>;
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    expect(wire.type).toBe("object");
    expect(wire.properties).toHaveProperty("credential");
    expect(wire.properties).toHaveProperty("connectionId");
    expect(wire.anyOf ?? wire.oneOf).toBeUndefined();
  });
});

describe("prepareRequestSecretArguments", () => {
  it("keeps a code request's site only", () => {
    expect(
      prepareRequestSecretArguments({
        label: "Code",
        purpose: "otp",
        oneTimeCode: { origin: "https://login.example.test/verify?code=123456", code: "123456" },
      }),
    ).toEqual({
      label: "Code",
      purpose: "otp",
      oneTimeCode: { origin: "https://login.example.test" },
    });
  });

  it("keeps credential, which is what makes the value persist", () => {
    expect(
      prepareRequestSecretArguments({
        label: "GitHub PAT",
        purpose: "api_key",
        credential: sampleCredential,
      }),
    ).toEqual({ label: "GitHub PAT", purpose: "api_key", credential: sampleCredential });
  });

  it("keeps a page URL's site, not its path or query", () => {
    expect(
      prepareRequestSecretArguments({
        label: "Sign in",
        purpose: "password",
        credential: {
          name: "site_login",
          origin: "https://www.example.test/some/login/page?x=1",
          auth: { type: "login" },
        },
      }),
    ).toEqual({
      label: "Sign in",
      purpose: "password",
      credential: {
        name: "site_login",
        origin: "https://www.example.test",
        auth: { type: "login" },
      },
    });
  });

  it("keeps replace, so an existing credential can be overwritten", () => {
    const credential = { name: "x", origin: "https://api.example.com", auth: { type: "bearer" } };
    const out = prepareRequestSecretArguments({
      label: "x",
      purpose: "api_key",
      credential,
      replace: true,
    });
    expect(out).toMatchObject({ replace: true, credential });
  });

  it("keeps only the labels of a login's fields, never a hidden choice or a value", () => {
    const credential = {
      name: "bank",
      origin: "https://bank.example.test",
      auth: { type: "login" },
    };
    const out = prepareRequestSecretArguments({
      label: "Bank",
      purpose: "password",
      credential,
      fields: ["ID number", { label: "Phone number", hidden: false, value: "fake-planted" }],
    });
    expect(out).toEqual({
      label: "Bank",
      purpose: "password",
      credential,
      fields: ["ID number", "Phone number"],
    });
  });

  it("still passes connectionId for the connector-code path", () => {
    const out = prepareRequestSecretArguments({ label: "c", purpose: "otp", connectionId: "abc" });
    expect(out).toEqual({ label: "c", purpose: "otp", connectionId: "abc" });
  });

  it("folds a top-level credential object and a JSON string into credential", () => {
    expect(
      prepareRequestSecretArguments({
        label: "API key",
        purpose: "api_key",
        name: sampleCredential.name,
        origin: sampleCredential.origin,
        auth: sampleCredential.auth,
      }),
    ).toEqual({ label: "API key", purpose: "api_key", credential: sampleCredential });
    expect(
      prepareRequestSecretArguments({
        label: "API key",
        purpose: "api_key",
        credential: JSON.stringify(sampleCredential),
        connectionId: "  ",
      }),
    ).toEqual({ label: "API key", purpose: "api_key", credential: sampleCredential });
  });

  it("drops planted secret fields before they reach prepared args", () => {
    const planted = "planted-secret-value";
    const fromObject = prepareRequestSecretArguments({
      label: "API key",
      purpose: "api_key",
      credential: { ...sampleCredential, value: planted, secret: planted },
    });
    expect(fromObject).toEqual({
      label: "API key",
      purpose: "api_key",
      credential: sampleCredential,
    });
    expect(JSON.stringify(fromObject)).not.toContain(planted);

    const fromString = prepareRequestSecretArguments({
      label: "API key",
      purpose: "api_key",
      credential: JSON.stringify({
        ...sampleCredential,
        value: planted,
        secret: planted,
        password: planted,
      }),
    });
    expect(fromString).toEqual({
      label: "API key",
      purpose: "api_key",
      credential: sampleCredential,
    });
    expect(JSON.stringify(fromString)).not.toContain(planted);
  });

  it("drops secrets nested in auth before they reach prepared args", () => {
    const planted = "planted-auth-secret";
    const auth = { type: "bearer" as const, token: planted, password: planted };
    const fromObject = prepareRequestSecretArguments({
      label: "API key",
      purpose: "api_key",
      credential: { ...sampleCredential, auth, value: planted },
    });
    expect(fromObject).toEqual({
      label: "API key",
      purpose: "api_key",
      credential: sampleCredential,
    });
    expect(JSON.stringify(fromObject)).not.toContain(planted);
    auth.token = "changed-after-copy";
    expect(fromObject).toEqual({
      label: "API key",
      purpose: "api_key",
      credential: sampleCredential,
    });

    const fromString = prepareRequestSecretArguments({
      label: "Login",
      purpose: "password",
      credential: JSON.stringify({
        name: "example_login",
        origin: `https://user:${planted}@login.example.test`,
        auth: { type: "login", password: planted },
      }),
    });
    expect(fromString).toEqual({
      label: "Login",
      purpose: "password",
      credential: {
        name: "example_login",
        origin: "https://login.example.test",
        auth: { type: "login" },
      },
    });
    expect(JSON.stringify(fromString)).not.toContain(planted);
  });

  it("omits credential and connectionId when absent rather than sending empties", () => {
    // The executor rejects a call that carries both, so neither may be faked in.
    expect(prepareRequestSecretArguments({ label: "c", purpose: "otp" })).toEqual({
      label: "c",
      purpose: "otp",
    });
  });

  it("rejects empty or missing label and purpose instead of inventing placeholders", () => {
    expect(() => prepareRequestSecretArguments({})).toThrow(
      "request_secret requires a non-empty label and purpose",
    );
    expect(() => prepareRequestSecretArguments({ purpose: "otp" })).toThrow(
      "request_secret requires a non-empty label and purpose",
    );
    expect(() => prepareRequestSecretArguments({ label: "c" })).toThrow(
      "request_secret requires a non-empty label and purpose",
    );
    expect(() => prepareRequestSecretArguments({ label: "", purpose: "otp" })).toThrow(
      "request_secret requires a non-empty label and purpose",
    );
    expect(() => prepareRequestSecretArguments({ label: "c", purpose: "  " })).toThrow(
      "request_secret requires a non-empty label and purpose",
    );
    expect(() =>
      prepareRequestSecretArguments({
        label: "c",
        purpose: "",
        credential: sampleCredential,
      }),
    ).toThrow("request_secret requires a non-empty label and purpose");
    expect(() => prepareRequestSecretArguments({ credential: sampleCredential })).toThrow(
      "received: credential",
    );
    expect(() => prepareRequestSecretArguments({})).toThrow("received: no arguments");
  });
});

describe("jsonField union handling", () => {
  it("converts a discriminated union instead of defaulting to string", () => {
    // BotSecretAuth converts to oneOf with no sibling `type`; as a string the model
    // would send `auth: "bearer"`, which the executor rejects.
    const authSchema = {
      oneOf: [
        { type: "object", properties: { type: { type: "string", const: "bearer" } } },
        {
          type: "object",
          properties: { type: { type: "string", const: "header" }, name: { type: "string" } },
        },
      ],
    };
    // A string schema converts to {type:"string"}; a union must not.
    expect((jsonField(authSchema) as { type?: string }).type).not.toBe("string");
  });

  it("still treats a plain string schema as a string", () => {
    expect((jsonField({ type: "string" }) as { type?: string }).type).toBe("string");
  });
});

describe("jsonField const handling", () => {
  it("preserves a const so the model knows the only accepted value", () => {
    // A plain string would leave the model guessing the discriminator value.
    // enumUnion wraps literals, so the value lands inside a single-member union.
    expect(JSON.stringify(jsonField({ type: "string", const: "bearer" }))).toContain(
      '"const":"bearer"',
    );
  });

  it("leaves a plain string alone", () => {
    expect(JSON.stringify(jsonField({ type: "string" }))).not.toContain("const");
  });
});

describe("request_secret login card arguments", () => {
  const login = {
    name: "example-login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  };

  it("accepts a login without a password as labeled fields", () => {
    const schema = requestSecretSchema();
    expect(
      parseConnectorToolArgs(schema, {
        label: "Example sign-in",
        purpose: "password",
        credential: login,
        fields: ["ID number", "Phone"],
      }),
    ).toMatchObject({ credential: login, fields: ["ID number", "Phone"] });
  });

  it("rejects a purpose outside the allowed values and an empty field list", () => {
    const schema = requestSecretSchema();
    expect(() =>
      parseConnectorToolArgs(schema, { label: "c", purpose: "login", credential: login }),
    ).toThrow();
    expect(() =>
      parseConnectorToolArgs(schema, { label: "c", purpose: "otp", credential: login, fields: [] }),
    ).toThrow();
  });
});
