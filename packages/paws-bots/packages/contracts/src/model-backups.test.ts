import { describe, expect, it } from "vitest";
import {
  connectedBackupOptions,
  connectionDisplayName,
  modelRoleChoiceKey,
  moveBackupChoice,
  sameBackupChoices,
  withConnectionName,
} from "./model-backups.js";
import type { ModelBackupChoice, ModelCatalogEntry, ModelCredential } from "./model-connections.js";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-sonnet",
    label: "Claude Sonnet",
    billing: "",
  },
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-haiku",
    label: "Claude Haiku",
    billing: "",
  },
  {
    provider: "unconnected",
    providerName: "Unconnected",
    id: "model-1",
    label: "Model 1",
    billing: "",
  },
  {
    provider: "anthropic",
    id: "anthropic-placeholder",
    label: "Anthropic",
    billing: "",
    placeholder: true,
  },
  {
    provider: "openai-compatible",
    providerName: "OpenAI-compatible",
    id: "custom-from-catalog",
    label: "Custom from catalog",
    billing: "",
  },
];
const credentials: ModelCredential[] = [
  {
    id: "cred-anthropic",
    provider: "anthropic",
    label: "Anthropic",
    hasKey: true,
    isDefault: true,
  },
  {
    id: "cred-openai-compatible",
    provider: "openai-compatible",
    label: "Local server",
    hasKey: true,
    isDefault: false,
    modelId: "custom-model",
  },
];
const choices: ModelBackupChoice[] = [
  { provider: "anthropic", modelId: "claude-sonnet" },
  { provider: "anthropic", modelId: "claude-haiku" },
];

describe("connected backup model choices", () => {
  it("treats the catalog's provider name as a default label", () => {
    const credential = { provider: "anthropic", label: "Anthropic", baseUrl: undefined };
    expect(connectionDisplayName(credential, "Claude subscription", ["Anthropic"])).toBe(
      "Claude subscription",
    );
    expect(connectionDisplayName({ ...credential, label: "Work" }, "Claude subscription")).toBe(
      "Claude subscription (Work)",
    );
  });
  it("offers computer use only seeing models on the member's own connections", () => {
    const managed: ModelCatalogEntry = {
      provider: "openrouter",
      providerName: "OpenRouter",
      id: "hosted-vision",
      label: "Hosted vision",
      billing: "",
      managed: true,
    };
    const local = {
      ...credentials[1]!,
      enabledModelIds: ["custom-model", "custom-vision"],
      visionModelIds: ["custom-vision"],
    };
    const offered = (computerUse: boolean) =>
      connectedBackupOptions([...catalog, managed], [credentials[0]!, local], computerUse).map(
        (option) => option.modelId,
      );
    expect(offered(false)).toEqual(expect.arrayContaining(["hosted-vision", "custom-model"]));
    expect(offered(true)).toContain("custom-vision");
    expect(offered(true)).not.toContain("custom-model");
    expect(offered(true)).not.toContain("hosted-vision");
  });
  it("offers only non-placeholder catalog models for connected providers", () => {
    expect(connectedBackupOptions(catalog, credentials)).toEqual([
      {
        provider: "anthropic",
        modelId: "claude-sonnet",
        label: "Claude Sonnet",
        providerName: "Anthropic",
        credentialId: "cred-anthropic",
        connectionName: "Anthropic",
      },
      {
        provider: "anthropic",
        modelId: "claude-haiku",
        label: "Claude Haiku",
        providerName: "Anthropic",
        credentialId: "cred-anthropic",
        connectionName: "Anthropic",
      },
      {
        provider: "openai-compatible",
        modelId: "custom-model",
        label: "custom-model",
        providerName: "openai-compatible",
        credentialId: "cred-openai-compatible",
        connectionName: "openai-compatible (Local server)",
      },
    ]);
  });

  it("keeps an unnamed compatible model and skips disconnected catalog rows", () => {
    const mobileCatalog: ModelCatalogEntry[] = [
      {
        provider: "anthropic",
        providerName: "Anthropic",
        id: "sonnet",
        label: "Sonnet",
        billing: "",
      },
      {
        provider: "anthropic",
        providerName: "Anthropic",
        id: "haiku",
        label: "Haiku",
        billing: "",
      },
      { provider: "other", id: "other-model", label: "Other", billing: "" },
      {
        provider: "anthropic",
        id: "placeholder",
        label: "Anthropic",
        billing: "",
        placeholder: true,
      },
      { provider: "openai-compatible", id: "server-model", label: "Server model", billing: "" },
    ];
    const mobileCredentials: ModelCredential[] = [
      {
        id: "anthropic-credential",
        provider: "anthropic",
        label: "Anthropic",
        hasKey: true,
        isDefault: false,
      },
      {
        id: "compatible-credential",
        provider: "openai-compatible",
        label: "Private endpoint",
        hasKey: true,
        isDefault: false,
        modelId: "custom-model",
      },
    ];

    expect(
      connectedBackupOptions(mobileCatalog, mobileCredentials).map(
        ({ provider, modelId, credentialId }) => ({ provider, modelId, credentialId }),
      ),
    ).toEqual([
      { provider: "anthropic", modelId: "sonnet", credentialId: "anthropic-credential" },
      { provider: "anthropic", modelId: "haiku", credentialId: "anthropic-credential" },
      {
        provider: "openai-compatible",
        modelId: "custom-model",
        credentialId: "compatible-credential",
      },
    ]);
  });

  it("offers one compatible option per enabled model id", () => {
    const enabled = credentials.map((credential) =>
      credential.provider === "openai-compatible"
        ? { ...credential, enabledModelIds: ["custom-model", "custom-from-catalog"] }
        : credential,
    );
    expect(
      connectedBackupOptions(catalog, enabled).filter(
        (option) => option.provider === "openai-compatible",
      ),
    ).toMatchObject([
      {
        provider: "openai-compatible",
        modelId: "custom-model",
        label: "custom-model",
        providerName: "openai-compatible",
      },
      {
        provider: "openai-compatible",
        modelId: "custom-from-catalog",
        label: "Custom from catalog",
        providerName: "OpenAI-compatible",
      },
    ]);
  });

  it("offers each compatible connection's own enabled ids", () => {
    const connection = credentials[1]!;
    expect(
      connectedBackupOptions(
        [],
        [
          { ...connection, modelId: undefined, enabledModelIds: ["a", "b"] },
          { ...connection, id: "second", modelId: undefined, enabledModelIds: ["b", "c"] },
          { ...connection, id: "empty", modelId: undefined },
        ],
      ).map((option) => [option.credentialId, option.modelId]),
    ).toEqual([
      ["cred-openai-compatible", "a"],
      ["cred-openai-compatible", "b"],
      ["second", "b"],
      ["second", "c"],
    ]);
  });

  it("offers a provider's models once per connection, named by the connection", () => {
    const work: ModelCredential = {
      ...credentials[0]!,
      id: "cred-anthropic-work",
      label: "Work",
      isDefault: false,
    };
    const options = connectedBackupOptions(catalog, [credentials[0]!, work]).filter(
      (option) => option.provider === "anthropic",
    );
    expect(options.map((option) => [option.connectionName, option.modelId])).toEqual([
      ["Anthropic", "claude-sonnet"],
      ["Anthropic", "claude-haiku"],
      ["Anthropic (Work)", "claude-sonnet"],
      ["Anthropic (Work)", "claude-haiku"],
    ]);
    expect(new Set(options.map(modelRoleChoiceKey)).size).toBe(4);
  });

  it("offers a model only under the connections that can run it", () => {
    const work: ModelCredential = { ...credentials[0]!, id: "cred-anthropic-work", label: "Work" };
    const limited = catalog.map((entry) =>
      entry.id === "claude-haiku" ? { ...entry, credentialIds: [work.id] } : entry,
    );
    expect(
      connectedBackupOptions(limited, [credentials[0]!, work])
        .filter((option) => option.provider === "anthropic")
        .map((option) => [option.credentialId, option.modelId]),
    ).toEqual([
      ["cred-anthropic", "claude-sonnet"],
      ["cred-anthropic-work", "claude-sonnet"],
      ["cred-anthropic-work", "claude-haiku"],
    ]);
  });

  it("offers deployment-managed models only while the provider has no connection", () => {
    const managed: ModelCatalogEntry = { ...catalog[2]!, managed: true };
    expect(connectedBackupOptions([managed], [])).toEqual([
      {
        provider: "unconnected",
        modelId: "model-1",
        label: "Model 1",
        providerName: "Unconnected",
        connectionName: "Unconnected",
      },
    ]);
  });

  it("names a connection by its label, adding the provider when the label omits it", () => {
    const base = { provider: "openai-codex", label: "ChatGPT" };
    expect(connectionDisplayName(base, "ChatGPT")).toBe("ChatGPT");
    expect(connectionDisplayName({ ...base, label: "ChatGPT 2" }, "ChatGPT")).toBe("ChatGPT 2");
    expect(connectionDisplayName({ ...base, label: "me@example.com" }, "ChatGPT")).toBe(
      "ChatGPT (me@example.com)",
    );
    expect(connectionDisplayName({ ...base, label: "openai-codex" }, "ChatGPT")).toBe("ChatGPT");
  });

  it.each([
    "Hosted service",
    "Hosted service Work",
    "hosted SERVICE Work",
    "  Hosted service Work  ",
  ])("does not repeat the endpoint name in %s", (label) => {
    expect(
      connectionDisplayName(
        { provider: "openai-compatible", endpointName: "Hosted service", label },
        "OpenAI-compatible",
      ),
    ).toBe(label.trim());
  });

  it("adds the endpoint name to a label that omits it", () => {
    expect(
      connectionDisplayName(
        { provider: "openai-compatible", endpointName: "Hosted service", label: "Work" },
        "OpenAI-compatible",
      ),
    ).toBe("Hosted service (Work)");
  });

  it("keeps compatible provider prefixes when there is no endpoint name", () => {
    expect(
      connectionDisplayName(
        { provider: "openai-compatible", label: "OpenAI-compatible Work" },
        "OpenAI-compatible",
      ),
    ).toBe("OpenAI-compatible Work");
  });

  it("does not duplicate the endpoint name in compatible backup options", () => {
    expect(
      connectedBackupOptions(catalog, [
        { ...credentials[1]!, endpointName: "Hosted service", label: "Hosted service Work" },
      ]).map((option) => option.connectionName),
    ).toEqual(["Hosted service Work"]);
  });

  it("moves a backup one place without changing the source list", () => {
    expect(moveBackupChoice(choices, 1, -1)).toEqual([choices[1], choices[0]]);
    expect(choices).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet" },
      { provider: "anthropic", modelId: "claude-haiku" },
    ]);
    expect(moveBackupChoice(choices, 0, -1)).toEqual(choices);
    expect(moveBackupChoice(choices, 1, 1)).toEqual(choices);
  });

  it("compares ordered pairs exactly", () => {
    expect(sameBackupChoices(choices, [...choices])).toBe(true);
    expect(sameBackupChoices(choices, [choices[1]!, choices[0]!])).toBe(false);
    expect(sameBackupChoices(choices, [{ ...choices[0]!, modelId: "other" }, choices[1]!])).toBe(
      false,
    );
  });
});

it("keeps saved Azure connections available for backup selection", () => {
  const legacy = { provider: "azure-openai-responses", modelId: "gpt-4o" };
  const current = { provider: "azure", modelId: "gpt-4o" };
  expect(
    connectedBackupOptions(
      [{ provider: "azure", id: "gpt-4o", label: "GPT-4o", billing: "" }],
      [
        {
          id: "credential-azure",
          provider: legacy.provider,
          label: "Azure",
          hasKey: true,
          isDefault: true,
        },
      ],
    ),
  ).toMatchObject([current]);
  expect(sameBackupChoices([legacy], [current])).toBe(true);
});

describe("withConnectionName", () => {
  it("names the connection after the model without nesting brackets", () => {
    expect(withConnectionName("Claude Sonnet", "OpenRouter")).toBe("Claude Sonnet (OpenRouter)");
    expect(withConnectionName("Claude Sonnet", "OpenRouter (Work)")).toBe(
      "Claude Sonnet (OpenRouter, Work)",
    );
  });
});
