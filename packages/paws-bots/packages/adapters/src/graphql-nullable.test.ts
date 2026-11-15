import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { importGraphqlSchema, prepareGraphqlInstall } from "./graphql-connectors.js";
import { InstalledConnectorProvider } from "./installed-connectors.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";

type TypeRef = { kind: string; name?: string; ofType?: TypeRef };
type Argument = { name: string; type: TypeRef; defaultValue?: string; description?: string };
const scalar = (name: string): TypeRef => ({ kind: "SCALAR", name });
const nonNull = (ofType: TypeRef): TypeRef => ({ kind: "NON_NULL", ofType });
const list = (ofType: TypeRef): TypeRef => ({ kind: "LIST", ofType });
const input: TypeRef = { kind: "INPUT_OBJECT", name: "ProfileInput" };
const episode: TypeRef = { kind: "ENUM", name: "Episode" };

function document(args: Argument[]) {
  return {
    data: {
      __schema: {
        mutationType: { name: "Mutation" },
        types: [
          {
            kind: "OBJECT",
            name: "Mutation",
            fields: [{ name: "updateProfile", args, type: scalar("Boolean") }],
          },
          { kind: "ENUM", name: "Episode", enumValues: [{ name: "NEWHOPE" }] },
          {
            ...input,
            inputFields: [
              { name: "id", type: nonNull(scalar("ID")) },
              { name: "nickname", type: scalar("String"), description: "Name to display" },
              { name: "episode", type: episode },
              { name: "tags", type: list(scalar("String")) },
              { name: "defaulted", type: nonNull(scalar("String")), defaultValue: '"fallback"' },
              { name: "nested", type: input },
            ],
          },
        ],
      },
    },
  };
}

function toolFor(args: Argument[]): ConnectorTool {
  const operation = importGraphqlSchema(document(args))[0]!;
  return {
    name: operation.name!,
    description: "Update a profile",
    inputSchema: operation.inputSchema,
  };
}

function schemasFor(tool: ConnectorTool): Record<string, unknown>[] {
  return [tool.inputSchema, JSON.parse(JSON.stringify(parametersFor(tool)))];
}

function piArguments(tool: ConnectorTool, args: JsonObject) {
  return validateToolArguments(
    { name: tool.name, description: tool.description, parameters: parametersFor(tool) },
    { type: "toolCall", id: "nullable-test", name: tool.name, arguments: args },
  ) as Record<string, unknown>;
}

describe("GraphQL nullable inputs", () => {
  it.each([
    ["String", scalar("String"), "text"],
    ["ID", scalar("ID"), "id"],
    ["Int", scalar("Int"), 1],
    ["Long", scalar("Long"), 1],
    ["Float", scalar("Float"), 1.5],
    ["Boolean", scalar("Boolean"), true],
    ["custom scalar", scalar("Date"), "2026-01-01"],
    ["enum", episode, "NEWHOPE"],
    ["input object", input, { id: "profile" }],
  ] satisfies Array<[string, TypeRef, JsonValue]>)(
    "keeps %s nullable while NON_NULL still rejects null",
    (_name, type, value) => {
      const tool = toolFor([
        { name: "optional", type, description: "An optional value" },
        { name: "required", type: nonNull(type) },
      ]);
      const args = { optional: null, required: value };
      for (const schema of schemasFor(tool)) {
        expect(parseConnectorToolArgs(schema, args)).toEqual(args);
        expect(parseConnectorToolArgs(schema, { required: value })).toEqual({ required: value });
        expect(() => parseConnectorToolArgs(schema, {})).toThrow();
        expect(() => parseConnectorToolArgs(schema, { required: null })).toThrow();
        expect(schema).toMatchObject({
          properties: { optional: { description: "An optional value" } },
        });
      }
      expect(piArguments(tool, args)).toEqual(args);
    },
  );

  it.each([
    ["[String]", list(scalar("String")), true, true],
    ["[String!]", list(nonNull(scalar("String"))), true, false],
    ["[String]!", nonNull(list(scalar("String"))), false, true],
    ["[String!]!", nonNull(list(nonNull(scalar("String")))), false, false],
  ] satisfies Array<[string, TypeRef, boolean, boolean]>)(
    "keeps the list and item nullability independent for %s",
    (_name, type, nullable, nullableItems) => {
      const tool = toolFor([{ name: "value", type }]);
      for (const schema of schemasFor(tool)) {
        expect(parseConnectorToolArgs(schema, { value: ["text"] })).toEqual({ value: ["text"] });
        for (const args of [{ value: null }, {}]) {
          if (nullable) expect(parseConnectorToolArgs(schema, args)).toEqual(args);
          else expect(() => parseConnectorToolArgs(schema, args)).toThrow();
        }
        if (nullableItems) {
          expect(parseConnectorToolArgs(schema, { value: [null] })).toEqual({ value: [null] });
          expect(piArguments(tool, { value: [null] })).toEqual({ value: [null] });
        } else expect(() => parseConnectorToolArgs(schema, { value: [null] })).toThrow();
      }
      if (nullable) expect(piArguments(tool, { value: null })).toEqual({ value: null });
    },
  );

  it("preserves nested nulls, descriptions, enum restrictions and the depth bound", () => {
    const tool = toolFor([{ name: "profile", type: input }]);
    expect(tool.inputSchema).toHaveProperty(
      "properties.profile.anyOf.0.properties.nickname.description",
      "Name to display",
    );
    expect(tool.inputSchema).toHaveProperty(
      "properties.profile.anyOf.0.properties.nested.anyOf.0.properties.nested",
      { anyOf: [{ type: "object" }, { type: "null" }] },
    );
    const args = {
      profile: {
        id: "profile",
        nickname: null,
        episode: null,
        tags: [null, "tag"],
        nested: { id: "nested", nickname: null, nested: null },
      },
    };
    for (const schema of schemasFor(tool)) {
      expect(parseConnectorToolArgs(schema, args)).toEqual(args);
      expect(() => parseConnectorToolArgs(schema, { profile: {} })).toThrow();
      expect(() => parseConnectorToolArgs(schema, { profile: { id: null } })).toThrow();
      expect(() =>
        parseConnectorToolArgs(schema, { profile: { id: "id", episode: "INVALID" } }),
      ).toThrow();
      expect(() =>
        parseConnectorToolArgs(schema, { profile: { id: "id", defaulted: null } }),
      ).toThrow();
    }
    expect(piArguments(tool, args)).toEqual(args);
  });

  it("allows omission but not null for defaulted non-null arguments", () => {
    const tool = toolFor([
      { name: "defaulted", type: nonNull(scalar("String")), defaultValue: '"fallback"' },
      { name: "nullableDefault", type: scalar("String"), defaultValue: '"fallback"' },
    ]);
    for (const schema of schemasFor(tool)) {
      expect(parseConnectorToolArgs(schema, {})).toEqual({});
      expect(parseConnectorToolArgs(schema, { nullableDefault: null })).toEqual({
        nullableDefault: null,
      });
      expect(() => parseConnectorToolArgs(schema, { defaulted: null })).toThrow();
    }
    const operation = importGraphqlSchema(
      document([
        { name: "defaulted", type: nonNull(scalar("String")), defaultValue: '"fallback"' },
      ]),
    )[0]!;
    expect(operation.variableTypes.defaulted).toBe("String");
  });

  it.each<JsonObject>([
    { nickname: null, episode: null, profile: null, tags: null },
    { profile: { id: "profile", nickname: null, tags: [null, "tag"] } },
    {},
  ])(
    "preserves explicit null versus omission from installation through execution: %j",
    async (args) => {
      const sent: Record<string, unknown>[] = [];
      const remote = {
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
        fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          if (body.operationName === "RakazoIntrospection") {
            return Response.json(
              document([
                { name: "nickname", type: scalar("String") },
                { name: "episode", type: episode },
                { name: "profile", type: input },
                { name: "tags", type: list(scalar("String")) },
              ]),
            );
          }
          sent.push(body.variables);
          return Response.json({ data: { updateProfile: true } });
        }),
      };
      const prepared = await prepareGraphqlInstall({
        source: "https://graphql.example.test/graphql",
        config: { auth: { type: "none" } },
        remote,
      });
      const install = {
        id: "graphql-nullable",
        kind: "graphql",
        name: "Profile",
        secretId: null,
        source: prepared.source,
        config: prepared.config,
      };
      const prisma = {
        capabilityInstall: {
          findMany: vi.fn().mockResolvedValue([install]),
          findFirst: vi.fn().mockResolvedValue(install),
        },
      };
      const provider = new InstalledConnectorProvider(prisma as never, {} as never, remote);
      const context = {
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      } as never;
      const [tool] = await provider.discoverTools(context);
      expect(tool).toBeDefined();
      expect(tool!.readOnly).toBe(false);
      const parsed = parseConnectorToolArgs(tool!.inputSchema, piArguments(tool!, args));
      expect(parsed).toEqual(args);
      const events = [];
      for await (const event of provider.execute(
        {
          tool: tool!.name,
          args: parsed,
          executionId: "nullable-call",
          route: tool!.route,
        },
        context,
      ))
        events.push(event);
      expect(events).toEqual([
        { type: "result", data: { status: 200, data: { updateProfile: true } } },
      ]);
      expect(sent).toEqual([args]);
      expect(remote.fetch).toHaveBeenCalledTimes(2);
    },
  );
});
